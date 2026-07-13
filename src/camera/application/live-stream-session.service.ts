import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { LiveStreamUnavailableError } from '../domain/errors/live-stream-unavailable.error';
import {
  createLiveStreamSession,
  createViewerToken,
  type LiveStreamLease,
  type LiveStreamMessageReference,
  type NewLiveStreamMessageReference,
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
  LIVE_STREAM_MESSAGE_CLEANUP,
  type LiveStreamMessageCleanupPort,
} from '../domain/ports/live-stream-message-cleanup.port';
import {
  MONOTONIC_CLOCK,
  type MonotonicClockPort,
} from '../domain/ports/monotonic-clock.port';
import { RtspSourceStartGate } from './rtsp-source-start-gate.service';

export interface OpenLiveStreamResult {
  watchUrl: string;
  grantId: string;
  remainingMs: number;
  expiresMonotonicMs: number;
  cameraName: string;
  registerMessageReference(reference: NewLiveStreamMessageReference): Promise<void>;
}

interface ActiveSession {
  session: LiveStreamSession;
  publicHostname: string;
  pid: LiveStreamLease['pid'];
  processIdentity: string;
  sourceKind: LiveStreamSource['kind'];
  viewerGrants: Map<number, ViewerGrant>;
  messageReferences: RuntimeMessageReference[];
}

interface ViewerGrant {
  grantId: string;
  tokenHash: string;
}

interface RuntimeMessageReference extends LiveStreamMessageReference {
  grantId: string;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

interface PendingOpen {
  /** Gateway-start input only; its provisional deadline is never exposed or persisted. */
  provisionalSession: LiveStreamSession;
  source: LiveStreamSource;
  requests: { telegramId: number; deferred: Deferred<OpenLiveStreamResult> }[];
  cancelled: boolean;
  replacement?: {
    source: LiveStreamSource;
    requests: { telegramId: number; deferred: Deferred<OpenLiveStreamResult> }[];
  };
}

interface CleanupBlocker {
  active: ActiveSession;
  teardownInFlight: boolean;
}

interface SourceKindStopWaiter {
  kind: LiveStreamSource['kind'];
  resolve(): void;
}

class OperationTimeoutError extends Error {}
class ViewerCapacityError extends Error {}

/**
 * Owns the one global live-stream state machine. A short queue serializes
 * transitions; gateway startup itself stays outside it so a stop can cancel a
 * still-pending cloud tunnel startup.
 */
@Injectable()
export class LiveStreamSessionService implements OnModuleInit, OnModuleDestroy {
  private queue: Promise<void> = Promise.resolve();
  private active?: ActiveSession;
  private cleanupBlocked?: CleanupBlocker;
  private pendingStartCleanup?: PendingOpen;
  private pending?: PendingOpen;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private leaseMutationTail: Promise<void> = Promise.resolve();
  private leaseMutationsPending = 0;
  private shuttingDown = false;
  private shutdownPromise?: Promise<void>;
  private readonly sourceKindStopWaiters = new Set<SourceKindStopWaiter>();

  constructor(
    @Inject(LIVE_STREAM_GATEWAY) private readonly gateway: LiveStreamGatewayPort,
    @Inject(LIVE_STREAM_LEASE) private readonly lease: LiveStreamLeasePort,
    @Inject(MONOTONIC_CLOCK) private readonly clock: MonotonicClockPort,
    @Inject(ADMIN_ALERT) private readonly alerts: AdminAlertPort,
    @Inject(LIVE_STREAM_MESSAGE_CLEANUP)
    private readonly messageCleanup: LiveStreamMessageCleanupPort,
    private readonly durationMs = 300_000,
    private readonly operationTimeoutMs = 30_000,
    private readonly maxViewers = 2,
    private readonly sourceStartGate = new RtspSourceStartGate(),
  ) {
    this.gateway.onFailure?.(() => {
      void this.stop(0).catch(() => undefined);
    });
  }

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
              sessionId: staleLease.sessionNonce,
              sourceKind: staleLease.sourceKind ?? 'motion-mjpeg',
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
    if (this.shuttingDown) return Promise.reject(new LiveStreamUnavailableError());
    try {
      this.sourceStartGate.assertCanStart(source.kind);
    } catch {
      return Promise.reject(new LiveStreamUnavailableError());
    }
    const deferred = createDeferred<OpenLiveStreamResult>();
    const queued = this.enqueue(async () => {
      try {
        this.sourceStartGate.assertCanStart(source.kind);
        if (this.leaseMutationsPending > 0) {
          deferred.reject(new LiveStreamUnavailableError());
          return;
        }

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
          await this.stopActive(() => this.sourceStartGate.assertCanStart(source.kind));
        }

        if (this.pending) {
          if (this.pending.cancelled) {
            if (this.pending.replacement?.source.cameraId === source.cameraId) {
              this.pending.replacement.requests.push({ telegramId, deferred });
              return;
            }
            deferred.reject(new LiveStreamUnavailableError());
            return;
          }
          if (this.pending.provisionalSession.cameraId === source.cameraId) {
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

  /** Cancels/stops only work for one source kind; other live sources continue. */
  async stopSourceKind(kind: LiveStreamSource['kind']): Promise<void> {
    try {
      await this.enqueue(async () => {
        const pending = this.pending;
        if (pending) {
          if (pending.replacement?.source.kind === kind) {
            this.rejectRequests(pending.replacement.requests);
            pending.replacement = undefined;
          }
          if (pending.source.kind === kind) {
            pending.cancelled = true;
            this.rejectPending(pending);
          }
        }

        if (this.cleanupBlocked?.active.sourceKind === kind) {
          if (!(await this.retryBlockedCleanup())) {
            throw new LiveStreamUnavailableError();
          }
        }

        if (this.active?.sourceKind === kind) {
          await this.stopActive();
        }
      });
      await this.waitForSourceKindToStop(kind);
    } catch {
      throw new LiveStreamUnavailableError();
    }
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

  /** Ordered process-shutdown entry point; module teardown reuses it defensively. */
  shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.shutdownPromise ??= this.enqueue(async () => {
      const pending = this.pending;
      if (pending) {
        pending.cancelled = true;
        this.rejectPending(pending);
        this.rejectReplacement(pending);
      }
      this.pending = undefined;
      this.pendingStartCleanup = undefined;

      const active = this.active ?? this.cleanupBlocked?.active;
      this.active = undefined;
      this.cleanupBlocked = undefined;
      this.clearExpiryTimer();

      let gatewayStopped = false;
      try {
        await this.withOperationTimeout(
          Promise.resolve().then(() => this.gateway.stop()),
        );
        gatewayStopped = true;
      } catch {
        // Process shutdown is best effort; gateway.stop owns its late cleanup.
      }

      if (active) await this.deleteMessageReferences(active.messageReferences);
      if (!gatewayStopped) return;
      try {
        await this.clearLease();
      } catch {
        // A stale lease is handled safely by boot recovery on the next start.
      }
    });
    return this.shutdownPromise;
  }

  onModuleDestroy(): Promise<void> {
    return this.shutdown();
  }

  revokeUser(telegramId: number): Promise<void> {
    return this.enqueue(async () => {
      if (!this.active) return;

      const grant = this.active.viewerGrants.get(telegramId);
      if (grant) {
        await this.withOperationTimeout(
          Promise.resolve().then(() => this.gateway.revokeViewer(grant.tokenHash)),
        );
      }
      this.active.viewerGrants.delete(telegramId);
      await this.removeMessageReference(this.active, telegramId);
    }).catch(() => {
      throw new LiveStreamUnavailableError();
    });
  }

  registerMessageReference(
    sessionId: string,
    telegramId: number,
    grantId: string,
    reference: NewLiveStreamMessageReference,
  ): Promise<void> {
    return this.enqueue(async () => {
      if (this.active?.session.id !== sessionId) return;
      const currentGrant = this.active.viewerGrants.get(telegramId);
      if (currentGrant?.grantId !== grantId) {
        await this.deleteMessageReferences([{ telegramId, ...reference }]);
        return;
      }
      const previousIndex = this.active.messageReferences.findIndex(
        (current) => current.telegramId === telegramId,
      );
      const previous = this.active.messageReferences[previousIndex];
      if (
        previous?.grantId === grantId &&
        previous.chatId === reference.chatId &&
        previous.messageId === reference.messageId
      ) return;

      const replacement = { telegramId, grantId, ...reference };
      const priorReferences = [...this.active.messageReferences];
      if (previousIndex >= 0) {
        this.active.messageReferences[previousIndex] = replacement;
      } else {
        this.active.messageReferences.push(replacement);
      }
      try {
        await this.writeLease(this.active);
      } catch {
        this.active.messageReferences = priorReferences;
        throw new LiveStreamUnavailableError();
      }
      if (previous) await this.deleteMessageReferences([previous]);
    }).catch(() => {
      throw new LiveStreamUnavailableError();
    });
  }

  private beginStart(
    source: LiveStreamSource,
    telegramId: number,
    deferred: Deferred<OpenLiveStreamResult>,
  ): void {
    try {
      this.sourceStartGate.assertCanStart(source.kind);
    } catch {
      deferred.reject(new LiveStreamUnavailableError());
      return;
    }
    const startedMonotonicMs = this.clock.now();
    const pending: PendingOpen = {
      source,
      provisionalSession: createLiveStreamSession({
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
      this.gateway.start({ session: pending.provisionalSession, source }),
    );

    void this.withOperationTimeout(start).then(
      (started) => {
        void this.enqueue(() => this.completeStart(pending, started)).catch(() => {
          // completeStart handles expected provisioning failures; this consumes
          // any unexpected callback failure from the fire-and-forget boundary.
        });
      },
      (error: unknown) => {
        const waitingForLateStart = error instanceof OperationTimeoutError;
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

    const readyMonotonicMs = this.clock.now();
    const activeDurationMs = pending.source.kind === 'rtsp'
      ? Math.max(0, pending.provisionalSession.expiresMonotonicMs - readyMonotonicMs)
      : this.durationMs;
    if (activeDurationMs < 1) {
      this.abortStartedPending(pending, {
        session: pending.provisionalSession,
        publicHostname: started.publicHostname,
        pid: started.pid,
        processIdentity: started.processIdentity,
        sourceKind: pending.source.kind,
        viewerGrants: new Map(),
        messageReferences: [],
      });
      return;
    }
    const active: ActiveSession = {
      session: createLiveStreamSession({
        id: pending.provisionalSession.id,
        cameraId: pending.provisionalSession.cameraId,
        cameraName: pending.provisionalSession.cameraName,
        startedMonotonicMs: readyMonotonicMs,
        durationMs: activeDurationMs,
      }),
      publicHostname: started.publicHostname,
      pid: started.pid,
      processIdentity: started.processIdentity,
      sourceKind: pending.source.kind,
      viewerGrants: new Map(),
      messageReferences: [],
    };

    if (pending.cancelled || !isQuickTunnelHostname(started.publicHostname)) {
      this.abortStartedPending(pending, active);
      return;
    }

    try {
      await this.writeLease(active);
      this.scheduleExpiry(active);

      const results: (OpenLiveStreamResult | undefined)[] = [];
      for (const request of pending.requests) {
        try {
          results.push(await this.createViewerResult(active, request.telegramId));
        } catch (error) {
          if (!(error instanceof ViewerCapacityError)) throw error;
          results.push(undefined);
        }
      }

      this.pending = undefined;
      this.active = active;
      for (const [index, request] of pending.requests.entries()) {
        const result = results[index];
        if (result) request.deferred.resolve(result);
        else request.deferred.reject(new LiveStreamUnavailableError());
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

    const previousGrant = active.viewerGrants.get(telegramId);
    if (!previousGrant && active.viewerGrants.size >= this.maxViewers) {
      throw new ViewerCapacityError();
    }
    if (previousGrant) {
      await this.withOperationTimeout(
        Promise.resolve().then(() => this.gateway.revokeViewer(previousGrant.tokenHash)),
      );
      active.viewerGrants.delete(telegramId);
      try {
        await this.removeMessageReference(active, telegramId);
      } catch (error) {
        try {
          await this.stopActive();
        } catch {
          // stopActive fences failed gateway cleanup before another open proceeds.
        }
        throw error;
      }
    }

    const grantId = randomUUID();
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
    active.viewerGrants.set(telegramId, { grantId, tokenHash });
    return {
      watchUrl: `https://${active.publicHostname}/watch/${token}`,
      grantId,
      remainingMs,
      expiresMonotonicMs: active.session.expiresMonotonicMs,
      cameraName: active.session.cameraName,
      registerMessageReference: (reference) =>
        this.registerMessageReference(active.session.id, telegramId, grantId, reference),
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

  private async stopActive(beforeStop?: () => void): Promise<string | null> {
    if (!this.active) return null;
    const cameraName = this.active.session.cameraName;
    await this.stopGateway(this.active, beforeStop);
    await this.deleteMessageReferences(this.active.messageReferences);
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
    if (this.active === active) {
      await this.deleteMessageReferences(active.messageReferences);
      this.active = undefined;
    }
    this.clearExpiryTimer();
    try {
      await this.clearLease();
    } catch {
      // A timed-out clear remains fenced until its underlying mutation settles.
      if (this.leaseMutationsPending > 0) return false;
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
      session: pending.provisionalSession,
      publicHostname: started.publicHostname,
      pid: started.pid,
      processIdentity: started.processIdentity,
      sourceKind: pending.source.kind,
      viewerGrants: new Map(),
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
        if (error instanceof OperationTimeoutError) {
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
    if (this.active === active) {
      await this.deleteMessageReferences(active.messageReferences);
      this.active = undefined;
    }
    this.clearExpiryTimer();
    try {
      await this.clearLease();
    } catch {
      if (pending) this.rejectReplacement(pending);
      return;
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

  private async stopGateway(
    active: ActiveSession,
    beforeStop?: () => void,
  ): Promise<void> {
    const stop = Promise.resolve().then(() => {
      beforeStop?.();
      return this.gateway.stop();
    });
    try {
      await this.withOperationTimeout(stop);
    } catch (error) {
      if (error instanceof OperationTimeoutError) {
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
        reject(new OperationTimeoutError());
      }, this.operationTimeoutMs);
      void operation.then(
        (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timeout);
          reject(error instanceof Error ? error : new Error('Operation failed'));
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
    await this.runLeaseMutation(() =>
      this.lease.write({
        sessionNonce: active.session.id,
        pid: active.pid,
        processIdentity: active.processIdentity,
        cameraId: active.session.cameraId,
        sourceKind: active.sourceKind,
        diagnosticExpiresAtUnixMs: Date.now() + Math.max(
          0,
          active.session.expiresMonotonicMs - this.clock.now(),
        ),
        messageReferences: active.messageReferences.map(
          ({ telegramId, chatId, messageId }) => ({ telegramId, chatId, messageId }),
        ),
      }),
    );
  }

  private async removeMessageReference(
    active: ActiveSession,
    telegramId: number,
  ): Promise<void> {
    const referenceIndex = active.messageReferences.findIndex(
      (reference) => reference.telegramId === telegramId,
    );
    if (referenceIndex < 0) return;
    const [reference] = active.messageReferences.splice(referenceIndex, 1);
    try {
      await this.writeLease(active);
    } finally {
      await this.deleteMessageReferences([reference]);
    }
  }

  private readLease(): Promise<LiveStreamLease | null> {
    return this.withOperationTimeout(Promise.resolve().then(() => this.lease.read()));
  }

  private async clearLease(): Promise<void> {
    await this.runLeaseMutation(() => this.lease.clear());
  }

  private async runLeaseMutation(operation: () => Promise<void>): Promise<void> {
    this.leaseMutationsPending += 1;
    const mutation = this.leaseMutationTail.then(operation);
    const settled = mutation.then(
      () => {
        this.leaseMutationsPending -= 1;
      },
      () => {
        this.leaseMutationsPending -= 1;
      },
    );
    this.leaseMutationTail = settled;
    await this.withOperationTimeout(mutation);
  }

  private async deleteMessageReferences(
    references: LiveStreamMessageReference[],
  ): Promise<void> {
    await Promise.all(
      references.map(async (reference) => {
        try {
          const cleanupReference: LiveStreamMessageReference = {
            telegramId: reference.telegramId,
            chatId: reference.chatId,
            messageId: reference.messageId,
          };
          await this.withOperationTimeout(
            Promise.resolve().then(() => this.messageCleanup.delete(cleanupReference)),
          );
        } catch {
          // Watch-message cleanup is best effort and never compromises teardown.
        }
      }),
    );
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
    requests: { telegramId: number; deferred: Deferred<OpenLiveStreamResult> }[],
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
    const guarded = async (): Promise<T> => {
      try {
        return await transition();
      } finally {
        this.resolveSourceKindStopWaiters();
      }
    };
    const run = this.queue.then(guarded, guarded);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async waitForSourceKindToStop(
    kind: LiveStreamSource['kind'],
  ): Promise<void> {
    const waiter: SourceKindStopWaiter = {
      kind,
      resolve: () => undefined,
    };
    const stopped = new Promise<void>((resolve) => {
      waiter.resolve = resolve;
    });
    await this.enqueue(async () => {
      if (this.hasSourceKindWork(kind)) this.sourceKindStopWaiters.add(waiter);
      else waiter.resolve();
    });
    try {
      await this.withOperationTimeout(stopped);
    } finally {
      this.sourceKindStopWaiters.delete(waiter);
    }
  }

  private resolveSourceKindStopWaiters(): void {
    for (const waiter of this.sourceKindStopWaiters) {
      if (this.hasSourceKindWork(waiter.kind)) continue;
      this.sourceKindStopWaiters.delete(waiter);
      waiter.resolve();
    }
  }

  private hasSourceKindWork(kind: LiveStreamSource['kind']): boolean {
    return this.active?.sourceKind === kind ||
      this.cleanupBlocked?.active.sourceKind === kind ||
      this.pending?.source.kind === kind ||
      this.pending?.replacement?.source.kind === kind ||
      this.pendingStartCleanup?.source.kind === kind;
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
