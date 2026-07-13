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

interface CleanupBlocker {
  active: ActiveSession;
  teardownInFlight: boolean;
}

class GatewayOperationTimeoutError extends Error {}

/**
 * Owns the one global live-stream state machine. A short queue serializes
 * transitions; gateway startup itself stays outside it so a stop can cancel a
 * still-pending cloud tunnel startup.
 */
@Injectable()
export class LiveStreamSessionService implements OnModuleInit {
  private queue: Promise<void> = Promise.resolve();
  private active?: ActiveSession;
  private cleanupBlocked?: CleanupBlocker;
  private pendingStartCleanup?: PendingOpen;
  private pending?: PendingOpen;
  private expiryTimer?: ReturnType<typeof setTimeout>;

  constructor(
    @Inject(LIVE_STREAM_GATEWAY) private readonly gateway: LiveStreamGatewayPort,
    @Inject(LIVE_STREAM_LEASE) private readonly lease: LiveStreamLeasePort,
    @Inject(MONOTONIC_CLOCK) private readonly clock: MonotonicClockPort,
    @Inject(ADMIN_ALERT) private readonly alerts: AdminAlertPort,
    private readonly durationMs = 300_000,
    private readonly operationTimeoutMs = 30_000,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.enqueue(async () => {
      let staleLease: LiveStreamLease | null;
      try {
        staleLease = await this.readLease();
      } catch {
        await this.alertRecoveryFailure();
        return;
      }

      if (!staleLease) return;

      try {
        const result = await this.withOperationTimeout(
          Promise.resolve().then(() =>
            this.gateway.recoverOwnedProcess({
              pid: staleLease.pid,
              processIdentity: staleLease.processIdentity,
            }),
          ),
        );
        if (result === 'not-owned') {
          await this.alertRecoveryFailure();
        }
      } catch {
        await this.alertRecoveryFailure();
      } finally {
        try {
          await this.clearLease();
        } catch {
          await this.alertRecoveryFailure();
        }
      }
    });
  }

  open(source: LiveStreamSource, telegramId: number): Promise<OpenLiveStreamResult> {
    const deferred = createDeferred<OpenLiveStreamResult>();
    const queued = this.enqueue(async () => {
      try {
        if (this.pendingStartCleanup) {
          deferred.reject(new LiveStreamUnavailableError());
          return;
        }

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
          if (this.pending.cancelled) {
            deferred.reject(new LiveStreamUnavailableError());
            return;
          }
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
      } catch {
        deferred.reject(new LiveStreamUnavailableError());
      }
    });

    return queued.then(() => deferred.promise);
  }

  stop(_telegramId: number): Promise<string | null> {
    return this.enqueue(async () => {
      if (this.pending) {
        this.pending.cancelled = true;
        this.rejectPending(this.pending);
        if (this.pending.replacement) {
          this.rejectRequests(this.pending.replacement.requests);
          this.pending.replacement = undefined;
        }
        return null;
      }
      if (this.cleanupBlocked) {
        if (!(await this.retryBlockedCleanup())) {
          throw new LiveStreamUnavailableError();
        }
        return null;
      }
      return this.stopActive();
    }).catch(() => {
      throw new LiveStreamUnavailableError();
    });
  }

  revokeUser(telegramId: number): Promise<void> {
    return this.enqueue(async () => {
      if (!this.active) return;

      const hashes = this.active.viewerTokenHashes.get(telegramId) ?? [];
      for (const tokenHash of hashes) {
        await this.withOperationTimeout(
          Promise.resolve().then(() => this.gateway.revokeViewer(tokenHash)),
        );
      }
      this.active.viewerTokenHashes.delete(telegramId);
    }).catch(() => {
      throw new LiveStreamUnavailableError();
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
      try {
        await this.writeLease(this.active);
      } catch {
        this.active.messageReferences.pop();
        throw new LiveStreamUnavailableError();
      }
    }).catch(() => {
      throw new LiveStreamUnavailableError();
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

    const start = Promise.resolve().then(() =>
      this.gateway.start({ session: pending.session, source }),
    );

    void this.withOperationTimeout(start).then(
      (started) => {
        void this.enqueue(() => this.completeStart(pending, started)).catch(() => {
          // completeStart handles expected provisioning failures; this consumes
          // any unexpected callback failure from the fire-and-forget boundary.
        });
      },
      (error: unknown) => {
        const waitingForLateStart = error instanceof GatewayOperationTimeoutError;
        if (waitingForLateStart) {
          void start.then(
            (started) => {
              void this.enqueue(() => this.cleanupLateStart(pending, started)).catch(() => {
                // The blocker remains in place if late cleanup cannot finish.
              });
            },
            () => {
              void this.enqueue(() => this.discardPendingStartCleanup(pending)).catch(() => {
                // Queue failures are contained at this detached callback boundary.
              });
            },
          );
        }
        void this.enqueue(() => this.failStart(pending, waitingForLateStart)).catch(() => {
          // failStart settles all deferreds and guards its replacement start.
        });
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
      this.abortStartedPending(pending, active);
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
      this.abortStartedPending(pending, active);
    }
  }

  private async failStart(
    pending: PendingOpen,
    waitingForLateStart = false,
  ): Promise<void> {
    if (this.pending !== pending) return;
    this.pending = undefined;
    if (waitingForLateStart) {
      this.pendingStartCleanup = pending;
    }
    this.rejectPending(pending);
    if (waitingForLateStart) {
      this.rejectReplacement(pending);
    } else {
      this.beginReplacement(pending);
    }
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
    await this.withOperationTimeout(
      Promise.resolve().then(() =>
        this.gateway.addViewer({
          tokenHash,
          telegramId,
          expiresMonotonicMs: active.session.expiresMonotonicMs,
        }),
      ),
    );
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
    await this.stopGateway(this.active);
    this.active = undefined;
    this.clearExpiryTimer();
    await this.clearLease();
    return cameraName;
  }

  private abortStartedPending(
    pending: PendingOpen,
    started: ActiveSession,
  ): void {
    this.pending = undefined;
    this.clearExpiryTimer();
    this.rejectPending(pending);
    this.startBlockedTeardown(started, pending);
  }

  private async retryBlockedCleanup(): Promise<boolean> {
    if (!this.cleanupBlocked) return true;
    if (this.cleanupBlocked.teardownInFlight) return false;

    const active = this.cleanupBlocked.active;

    try {
      await this.stopGateway(active);
    } catch {
      return false;
    }

    this.cleanupBlocked = undefined;
    if (this.active === active) this.active = undefined;
    this.clearExpiryTimer();
    try {
      await this.clearLease();
    } catch {
      // The tunnel is confirmed stopped, so a stale lease cannot create a duplicate tunnel.
    }
    return true;
  }

  private async cleanupLateStart(
    pending: PendingOpen,
    started: Awaited<ReturnType<LiveStreamGatewayPort['start']>>,
  ): Promise<void> {
    if (this.pendingStartCleanup !== pending) return;
    this.pendingStartCleanup = undefined;
    this.startBlockedTeardown({
      session: pending.session,
      publicHostname: started.publicHostname,
      pid: started.pid,
      processIdentity: started.processIdentity,
      viewerTokenHashes: new Map(),
      messageReferences: [],
    });
  }

  private async discardPendingStartCleanup(pending: PendingOpen): Promise<void> {
    if (this.pendingStartCleanup === pending) {
      this.pendingStartCleanup = undefined;
    }
  }

  private startBlockedTeardown(active: ActiveSession, pending?: PendingOpen): void {
    const teardown = Promise.resolve().then(() => this.gateway.stop());
    this.cleanupBlocked = { active, teardownInFlight: true };

    void this.withOperationTimeout(teardown).then(
      () => {
        void this.enqueue(() => this.finishBlockedTeardown(active, pending)).catch(() => {
          // A cleanup blocker must not create an unhandled rejection.
        });
      },
      (error: unknown) => {
        if (error instanceof GatewayOperationTimeoutError) {
          void this.enqueue(async () => {
            if (pending) this.rejectReplacement(pending);
          }).catch(() => {
            // A timed-out cleanup cannot leave a replacement caller pending.
          });
          void teardown.then(
            () => {
              void this.enqueue(() => this.finishBlockedTeardown(active, pending)).catch(() => {
                // A cleanup blocker must not create an unhandled rejection.
              });
            },
            () => {
              void this.enqueue(() => this.failBlockedTeardown(active, pending)).catch(() => {
                // A cleanup blocker must not create an unhandled rejection.
              });
            },
          );
          return;
        }
        void this.enqueue(() => this.failBlockedTeardown(active, pending)).catch(() => {
          // A cleanup blocker must not create an unhandled rejection.
        });
      },
    );
  }

  private async finishBlockedTeardown(
    active: ActiveSession,
    pending?: PendingOpen,
  ): Promise<void> {
    if (this.cleanupBlocked?.active !== active) return;
    this.cleanupBlocked = undefined;
    if (this.active === active) this.active = undefined;
    this.clearExpiryTimer();
    try {
      await this.clearLease();
    } catch {
      // The tunnel is confirmed stopped, so a stale lease cannot create a duplicate tunnel.
    }
    if (pending) this.beginReplacement(pending);
  }

  private async failBlockedTeardown(
    active: ActiveSession,
    pending?: PendingOpen,
  ): Promise<void> {
    if (this.cleanupBlocked?.active !== active) return;
    this.cleanupBlocked.teardownInFlight = false;
    if (pending) this.rejectReplacement(pending);
  }

  private async stopGateway(active: ActiveSession): Promise<void> {
    const stop = Promise.resolve().then(() => this.gateway.stop());
    try {
      await this.withOperationTimeout(stop);
    } catch (error) {
      if (error instanceof GatewayOperationTimeoutError) {
        this.cleanupBlocked = { active, teardownInFlight: true };
        void stop.then(
          () => {
            void this.enqueue(() => this.finishBlockedTeardown(active)).catch(() => {
              // A cleanup blocker must not create an unhandled rejection.
            });
          },
          () => {
            void this.enqueue(() => this.failBlockedTeardown(active)).catch(() => {
              // A cleanup blocker must not create an unhandled rejection.
            });
          },
        );
      }
      throw error;
    }
  }

  private withOperationTimeout<T>(operation: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new GatewayOperationTimeoutError());
      }, this.operationTimeoutMs);
      void operation.then(
        (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timeout);
          reject(error);
        },
      );
    });
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
      void this.enqueue(() => this.expireIfDue()).catch(() => {
        // stopActive retains the active session when cleanup fails; a later
        // open or stop retries it without leaking an unhandled rejection.
      });
    }, remainingMs);
  }

  private async writeLease(active: ActiveSession): Promise<void> {
    await this.withOperationTimeout(
      Promise.resolve().then(() =>
        this.lease.write({
          sessionNonce: active.session.id,
          pid: active.pid,
          processIdentity: active.processIdentity,
          cameraId: active.session.cameraId,
          diagnosticExpiresAtUnixMs: Date.now() + Math.max(
            0,
            active.session.expiresMonotonicMs - this.clock.now(),
          ),
          messageReferences: [...active.messageReferences],
        }),
      ),
    );
  }

  private readLease(): Promise<LiveStreamLease | null> {
    return this.withOperationTimeout(Promise.resolve().then(() => this.lease.read()));
  }

  private async clearLease(): Promise<void> {
    await this.withOperationTimeout(Promise.resolve().then(() => this.lease.clear()));
  }

  private async alertRecoveryFailure(): Promise<void> {
    try {
      await this.alerts.alert('live-stream-recovery-failed');
    } catch {
      // Recovery is best effort. Do not expose adapter diagnostics during boot.
    }
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
