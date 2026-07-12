import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { LiveStreamUnavailableError } from '../domain/errors/live-stream-unavailable.error';
import {
  createLiveStreamSession,
  createViewerToken,
  type LiveStreamLease,
  type LiveStreamMessageReference,
  type LiveStreamSession,
  type LiveStreamSource,
} from '../domain/live-stream.entity';
import {
  ADMIN_ALERT,
  type AdminAlertPort,
} from '../domain/ports/admin-alert.port';
import {
  LIVE_STREAM_GATEWAY,
  type LiveStreamGatewayPort,
} from '../domain/ports/live-stream-gateway.port';
import {
  LIVE_STREAM_LEASE,
  type LiveStreamLeasePort,
} from '../domain/ports/live-stream-lease.port';
import {
  MONOTONIC_CLOCK,
  type MonotonicClockPort,
} from '../domain/ports/monotonic-clock.port';

export interface OpenLiveStreamResult {
  watchUrl: string;
  remainingMs: number;
  expiresMonotonicMs: number;
  cameraName: string;
  registerMessageReference(reference: LiveStreamMessageReference): Promise<void>;
}

interface ActiveSession {
  session: LiveStreamSession;
  publicHostname: string;
  pid: LiveStreamLease['pid'];
  processIdentity: string;
  viewerTokenHashes: Map<number, string[]>;
  messageReferences: LiveStreamMessageReference[];
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

interface PendingOpen {
  session: LiveStreamSession;
  source: LiveStreamSource;
  requests: Array<{ telegramId: number; deferred: Deferred<OpenLiveStreamResult> }>;
  cancelled: boolean;
  replacement?: {
    source: LiveStreamSource;
    requests: Array<{ telegramId: number; deferred: Deferred<OpenLiveStreamResult> }>;
  };
}

/**
 * Owns the one global live-stream state machine. A short queue serializes
 * transitions; gateway startup itself stays outside it so a stop can cancel a
 * still-pending cloud tunnel startup.
 */
@Injectable()
export class LiveStreamSessionService implements OnModuleInit {
  private queue: Promise<void> = Promise.resolve();
  private active?: ActiveSession;
  private cleanupBlocked?: ActiveSession;
  private pending?: PendingOpen;
  private expiryTimer?: ReturnType<typeof setTimeout>;

  constructor(
    @Inject(LIVE_STREAM_GATEWAY) private readonly gateway: LiveStreamGatewayPort,
    @Inject(LIVE_STREAM_LEASE) private readonly lease: LiveStreamLeasePort,
    @Inject(MONOTONIC_CLOCK) private readonly clock: MonotonicClockPort,
    @Inject(ADMIN_ALERT) private readonly alerts: AdminAlertPort,
    private readonly durationMs = 300_000,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.enqueue(async () => {
      let staleLease: LiveStreamLease | null;
      try {
        staleLease = await this.lease.read();
      } catch {
        await this.alerts.alert('live-stream-recovery-failed');
        return;
      }

      if (!staleLease) return;

      try {
        const result = await this.gateway.recoverOwnedProcess({
          pid: staleLease.pid,
          processIdentity: staleLease.processIdentity,
        });
        if (result === 'not-owned') {
          await this.alerts.alert('live-stream-recovery-failed');
        }
      } catch {
        await this.alerts.alert('live-stream-recovery-failed');
      } finally {
        await this.lease.clear();
      }
    });
  }

  open(source: LiveStreamSource, telegramId: number): Promise<OpenLiveStreamResult> {
    const deferred = createDeferred<OpenLiveStreamResult>();
    const queued = this.enqueue(async () => {
      if (this.cleanupBlocked && !(await this.retryBlockedCleanup())) {
        deferred.reject(new LiveStreamUnavailableError());
        return;
      }

      await this.expireIfDue();

      if (this.active?.session.cameraId === source.cameraId) {
        await this.openViewer(this.active, telegramId, deferred);
        return;
      }

      if (this.active) {
        await this.stopActive();
      }

      if (this.pending) {
        if (this.pending.session.cameraId === source.cameraId) {
          this.pending.requests.push({ telegramId, deferred });
          return;
        }

        this.pending.cancelled = true;
        if (this.pending.replacement?.source.cameraId === source.cameraId) {
          this.pending.replacement.requests.push({ telegramId, deferred });
        } else {
          if (this.pending.replacement) {
            this.rejectRequests(this.pending.replacement.requests);
          }
          this.pending.replacement = {
            source,
            requests: [{ telegramId, deferred }],
          };
        }
        return;
      }

      this.beginStart(source, telegramId, deferred);
    });

    return queued.then(() => deferred.promise);
  }

  stop(_telegramId: number): Promise<string | null> {
    return this.enqueue(async () => {
      if (this.pending) {
        this.pending.cancelled = true;
        if (this.pending.replacement) {
          this.rejectRequests(this.pending.replacement.requests);
          this.pending.replacement = undefined;
        }
        return null;
      }
      if (this.cleanupBlocked) {
        await this.retryBlockedCleanup();
        return null;
      }
      return this.stopActive();
    });
  }

  revokeUser(telegramId: number): Promise<void> {
    return this.enqueue(async () => {
      if (!this.active) return;

      const hashes = this.active.viewerTokenHashes.get(telegramId) ?? [];
      for (const tokenHash of hashes) {
        await this.gateway.revokeViewer(tokenHash);
      }
      this.active.viewerTokenHashes.delete(telegramId);
    });
  }

  registerMessageReference(
    sessionId: string,
    reference: LiveStreamMessageReference,
  ): Promise<void> {
    return this.enqueue(async () => {
      if (!this.active || this.active.session.id !== sessionId) return;
      if (
        this.active.messageReferences.some(
          (current) =>
            current.chatId === reference.chatId && current.messageId === reference.messageId,
        )
      ) {
        return;
      }

      this.active.messageReferences.push(reference);
      await this.writeLease(this.active);
    });
  }

  private beginStart(
    source: LiveStreamSource,
    telegramId: number,
    deferred: Deferred<OpenLiveStreamResult>,
  ): void {
    const startedMonotonicMs = this.clock.now();
    const pending: PendingOpen = {
      source,
      session: createLiveStreamSession({
        id: randomUUID(),
        cameraId: source.cameraId,
        cameraName: source.cameraName,
        startedMonotonicMs,
        durationMs: this.durationMs,
      }),
      requests: [{ telegramId, deferred }],
      cancelled: false,
    };
    this.pending = pending;

    void this.gateway.start({ session: pending.session, source }).then(
      (started) => {
        void this.enqueue(() => this.completeStart(pending, started));
      },
      () => {
        void this.enqueue(() => this.failStart(pending));
      },
    );
  }

  private async completeStart(
    pending: PendingOpen,
    started: Awaited<ReturnType<LiveStreamGatewayPort['start']>>,
  ): Promise<void> {
    if (this.pending !== pending) return;

    const active: ActiveSession = {
      session: pending.session,
      publicHostname: started.publicHostname,
      pid: started.pid,
      processIdentity: started.processIdentity,
      viewerTokenHashes: new Map(),
      messageReferences: [],
    };

    if (pending.cancelled || !isQuickTunnelHostname(started.publicHostname)) {
      await this.abortStartedPending(pending, active);
      return;
    }

    try {
      await this.writeLease(active);
      this.scheduleExpiry(active);

      const results: OpenLiveStreamResult[] = [];
      for (const request of pending.requests) {
        results.push(await this.createViewerResult(active, request.telegramId));
      }

      this.pending = undefined;
      this.active = active;
      for (const [index, request] of pending.requests.entries()) {
        request.deferred.resolve(results[index]);
      }
    } catch {
      await this.abortStartedPending(pending, active);
    }
  }

  private async failStart(pending: PendingOpen): Promise<void> {
    if (this.pending !== pending) return;
    this.pending = undefined;
    this.rejectPending(pending);
    this.beginReplacement(pending);
  }

  private async openViewer(
    active: ActiveSession,
    telegramId: number,
    deferred: Deferred<OpenLiveStreamResult>,
  ): Promise<void> {
    try {
      deferred.resolve(await this.createViewerResult(active, telegramId));
    } catch {
      deferred.reject(new LiveStreamUnavailableError());
    }
  }

  private async createViewerResult(
    active: ActiveSession,
    telegramId: number,
  ): Promise<OpenLiveStreamResult> {
    const remainingMs = active.session.expiresMonotonicMs - this.clock.now();
    if (remainingMs <= 0) {
      await this.stopActive();
      throw new LiveStreamUnavailableError();
    }

    const token = createViewerToken(randomBytes(32));
    const tokenHash = createHash('sha256').update(token).digest('hex');
    await this.gateway.addViewer({
      tokenHash,
      telegramId,
      expiresMonotonicMs: active.session.expiresMonotonicMs,
    });
    const hashes = active.viewerTokenHashes.get(telegramId) ?? [];
    hashes.push(tokenHash);
    active.viewerTokenHashes.set(telegramId, hashes);
    return {
      watchUrl: `https://${active.publicHostname}/watch/${token}`,
      remainingMs,
      expiresMonotonicMs: active.session.expiresMonotonicMs,
      cameraName: active.session.cameraName,
      registerMessageReference: (reference) =>
        this.registerMessageReference(active.session.id, reference),
    };
  }

  private async expireIfDue(): Promise<void> {
    if (
      this.active &&
      this.clock.now() >= this.active.session.expiresMonotonicMs
    ) {
      await this.stopActive();
    }
  }

  private async stopActive(): Promise<string | null> {
    if (!this.active) return null;
    const cameraName = this.active.session.cameraName;
    await this.gateway.stop();
    this.active = undefined;
    this.clearExpiryTimer();
    await this.lease.clear();
    return cameraName;
  }

  private async abortStartedPending(
    pending: PendingOpen,
    started: ActiveSession,
  ): Promise<void> {
    this.pending = undefined;
    this.clearExpiryTimer();

    let stopped = false;
    try {
      await this.gateway.stop();
      stopped = true;
    } catch {
      this.cleanupBlocked = started;
    }

    try {
      await this.lease.clear();
    } catch {
      // Cleanup is best effort; the in-memory blocker still prevents a duplicate tunnel.
    }

    this.rejectPending(pending);
    if (stopped) {
      this.beginReplacement(pending);
    } else {
      this.rejectReplacement(pending);
    }
  }

  private async retryBlockedCleanup(): Promise<boolean> {
    if (!this.cleanupBlocked) return true;

    try {
      await this.gateway.stop();
    } catch {
      return false;
    }

    this.cleanupBlocked = undefined;
    this.clearExpiryTimer();
    try {
      await this.lease.clear();
    } catch {
      // The tunnel is confirmed stopped, so a stale lease cannot create a duplicate tunnel.
    }
    return true;
  }

  private clearExpiryTimer(): void {
    if (!this.expiryTimer) return;
    clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
  }

  private scheduleExpiry(active: ActiveSession): void {
    const remainingMs = Math.max(
      0,
      active.session.expiresMonotonicMs - this.clock.now(),
    );
    this.expiryTimer = setTimeout(() => {
      void this.enqueue(() => this.expireIfDue());
    }, remainingMs);
  }

  private async writeLease(active: ActiveSession): Promise<void> {
    await this.lease.write({
      sessionNonce: active.session.id,
      pid: active.pid,
      processIdentity: active.processIdentity,
      cameraId: active.session.cameraId,
      diagnosticExpiresAtUnixMs: Date.now() + Math.max(
        0,
        active.session.expiresMonotonicMs - this.clock.now(),
      ),
      messageReferences: [...active.messageReferences],
    });
  }

  private rejectPending(pending: PendingOpen): void {
    this.rejectRequests(pending.requests);
  }

  private rejectRequests(
    requests: Array<{ telegramId: number; deferred: Deferred<OpenLiveStreamResult> }>,
  ): void {
    for (const request of requests) {
      request.deferred.reject(new LiveStreamUnavailableError());
    }
  }

  private rejectReplacement(pending: PendingOpen): void {
    if (!pending.replacement) return;
    this.rejectRequests(pending.replacement.requests);
    pending.replacement = undefined;
  }

  private beginReplacement(pending: PendingOpen): void {
    if (!pending.replacement) return;
    const replacement = pending.replacement;
    const [first, ...joiningRequests] = replacement.requests;
    if (!first) return;
    this.beginStart(replacement.source, first.telegramId, first.deferred);
    this.pending?.requests.push(...joiningRequests);
  }

  private enqueue<T>(transition: () => Promise<T>): Promise<T> {
    const run = this.queue.then(transition, transition);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function isQuickTunnelHostname(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$/i.test(value);
}
