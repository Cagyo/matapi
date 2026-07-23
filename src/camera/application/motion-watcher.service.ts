import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { FEATURE_AVAILABILITY, type FeatureAvailabilityPort } from '../../features/domain/ports/feature-availability.port';
import { CAMERA_MODE, CameraMode } from '../camera.tokens';
import { ADMIN_ALERT, AdminAlertPort } from '../domain/ports/admin-alert.port';
import { MOTION_DESIRED_STATE_KEY } from '../domain/motion-desired-state';
import {
  MOTION_CONTROL,
  MotionControlPort,
} from '../domain/ports/motion-control.port';
import {
  SYSTEM_META_REPOSITORY,
  SystemMetaRepositoryPort,
} from '../../system/domain/ports/system-meta-repository.port';

const DEFAULT_INTERVAL_MS = 60_000;
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_BACKOFF_MS = 2_000;

/**
 * Watches the Motion daemon health (spec 20, 23). On each tick it checks
 * `isActive()`; if the daemon is down — and `motion_desired_state` is not
 * `'off'` — it attempts up to three restarts with backoff. A persistent
 * failure alerts admins once and marks the camera subsystem degraded;
 * recovery alerts once and clears the flag. Only active in `real` mode —
 * stub mode has no daemon to watch.
 */
@Injectable()
export class MotionWatcherService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(MotionWatcherService.name);
  private timer?: NodeJS.Timeout;
  private backoffTimer?: NodeJS.Timeout;
  private resolveBackoff?: () => void;
  private degraded = false;
  private wanted = false;
  private stopped = false;
  private generation = 0;
  private inFlight?: Promise<void>;

  constructor(
    @Inject(CAMERA_MODE) private readonly mode: CameraMode,
    @Inject(MOTION_CONTROL) private readonly motion: MotionControlPort,
    @Inject(ADMIN_ALERT) private readonly adminAlert: AdminAlertPort,
    @Inject(SYSTEM_META_REPOSITORY) private readonly meta: SystemMetaRepositoryPort,
    @Inject(FEATURE_AVAILABILITY) private readonly availability?: FeatureAvailabilityPort,
  ) {}

  onApplicationBootstrap(): void {
    void this.start().catch(() => undefined);
  }

  async start(): Promise<void> {
    if (this.mode !== 'real' || this.wanted) return;
    const generation = ++this.generation;
    this.wanted = true;
    this.stopped = false;
    try {
      await this.availability?.requireReady('motion');
    } catch (error) {
      if (this.isCurrent(generation)) this.wanted = false;
      throw error;
    }
    if (this.mode !== 'real' || !this.wanted || !this.isCurrent(generation)) return;

    const interval = this.resolveInterval();
    this.timer = setInterval(() => {
      void this.runTick(generation);
    }, interval);
    // Don't keep the event loop alive solely for the watcher.
    this.timer.unref?.();
    this.logger.log(`Motion watcher active (every ${interval}ms)`);
    void this.runTick(generation);
  }

  async stop(): Promise<void> {
    this.wanted = false;
    this.stopped = true;
    this.generation++;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.backoffTimer) clearTimeout(this.backoffTimer);
    this.backoffTimer = undefined;
    this.resolveBackoff?.();
    this.resolveBackoff = undefined;
    await this.inFlight;
  }

  onModuleDestroy(): void { void this.stop(); }

  /** Exposed for `/health` (spec 08, 23). */
  isDegraded(): boolean {
    return this.degraded;
  }

  private runTick(generation: number): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.tick(generation).finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async tick(generation = this.generation): Promise<void> {
    if (!this.isCurrent(generation)) return;
    try {
      await this.requireCurrent(generation);
      if (await this.motion.isActive()) {
        if (this.degraded) { await this.requireCurrent(generation); await this.recover(); }
        return;
      }

      if (await this.isMotionDesiredOff()) {
        // Deliberate stop (/camera disable or emergency cleanup) — not a
        // failure. Stand down silently; /camera enable re-arms the watcher.
        this.degraded = false;
        return;
      }

      const restored = await this.tryRestart(generation);
      if (restored) {
        if (this.degraded) { await this.requireCurrent(generation); await this.recover(); }
      } else {
        await this.requireCurrent(generation);
        await this.markDown();
      }
    } catch (error) {
      this.logger.warn(`Motion watch tick failed: ${(error as Error).message}`);
    }
  }

  private async tryRestart(generation: number): Promise<boolean> {
    for (let attempt = 1; attempt <= MAX_RESTART_ATTEMPTS; attempt++) {
      await this.requireCurrent(generation);
      if (await this.isMotionDesiredOff()) {
        // A deliberate stop landed while we were mid-recovery — e.g.
        // /camera disable during the ~2s backoff between attempts. The
        // tick-top gate can't catch this, and a restart that wins here
        // sticks: the healthy path never consults desired state again.
        this.degraded = false;
        return true;
      }
      try {
        await this.requireCurrent(generation);
        await this.motion.restart();
        await this.requireCurrent(generation);
        if (await this.motion.isActive()) {
          this.logger.log(`Motion daemon restarted (attempt ${attempt})`);
          return true;
        }
      } catch (error) {
        this.logger.warn(
          `Motion restart attempt ${attempt} failed: ${(error as Error).message}`,
        );
      }
      if (attempt < MAX_RESTART_ATTEMPTS) await this.sleep(RESTART_BACKOFF_MS, generation);
    }
    return false;
  }

  private async isMotionDesiredOff(): Promise<boolean> {
    try {
      return (await this.meta.get(MOTION_DESIRED_STATE_KEY)) === 'off';
    } catch (error) {
      this.logger.warn(
        `Failed to read motion desired state; assuming on: ${(error as Error).message}`,
      );
      return false;
    }
  }

  private async markDown(): Promise<void> {
    if (this.degraded) return; // already alerted
    this.degraded = true;
    this.logger.error('Motion daemon down and could not be restarted');
    await this.adminAlert.alert('motion-daemon-down');
  }

  private async recover(): Promise<void> {
    this.degraded = false;
    this.logger.log('Motion daemon recovered');
    await this.adminAlert.alert('motion-daemon-recovered');
  }

  private resolveInterval(): number {
    const raw = Number(process.env.MOTION_HEALTH_INTERVAL_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INTERVAL_MS;
  }

  private isCurrent(generation: number): boolean { return !this.stopped && generation === this.generation; }

  private async requireCurrent(generation: number): Promise<void> {
    if (!this.isCurrent(generation)) throw new WatcherStoppedError();
    await this.availability?.requireReady('motion');
    if (!this.isCurrent(generation)) throw new WatcherStoppedError();
  }

  private sleep(ms: number, generation: number): Promise<void> {
    return new Promise((resolve) => {
      this.resolveBackoff = resolve;
      this.backoffTimer = setTimeout(() => {
        this.backoffTimer = undefined;
        this.resolveBackoff = undefined;
        resolve();
      }, ms);
    });
  }
}

class WatcherStoppedError extends Error {}
