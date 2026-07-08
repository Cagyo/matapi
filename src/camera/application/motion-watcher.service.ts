import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
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
  private degraded = false;
  private checking = false;

  constructor(
    @Inject(CAMERA_MODE) private readonly mode: CameraMode,
    @Inject(MOTION_CONTROL) private readonly motion: MotionControlPort,
    @Inject(ADMIN_ALERT) private readonly adminAlert: AdminAlertPort,
    @Inject(SYSTEM_META_REPOSITORY) private readonly meta: SystemMetaRepositoryPort,
  ) {}

  onApplicationBootstrap(): void {
    if (this.mode !== 'real') return;

    const interval = this.resolveInterval();
    this.timer = setInterval(() => {
      void this.tick();
    }, interval);
    // Don't keep the event loop alive solely for the watcher.
    this.timer.unref?.();
    this.logger.log(`Motion watcher active (every ${interval}ms)`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Exposed for `/health` (spec 08, 23). */
  isDegraded(): boolean {
    return this.degraded;
  }

  private async tick(): Promise<void> {
    if (this.checking) return; // skip if a slow check overran the interval
    this.checking = true;
    try {
      if (await this.motion.isActive()) {
        if (this.degraded) await this.recover();
        return;
      }

      if ((await this.meta.get(MOTION_DESIRED_STATE_KEY)) === 'off') {
        // Deliberate stop (/camera disable or emergency cleanup) — not a
        // failure. Stand down silently; /camera enable re-arms the watcher.
        this.degraded = false;
        return;
      }

      const restored = await this.tryRestart();
      if (restored) {
        if (this.degraded) await this.recover();
      } else {
        await this.markDown();
      }
    } catch (error) {
      this.logger.warn(`Motion watch tick failed: ${(error as Error).message}`);
    } finally {
      this.checking = false;
    }
  }

  private async tryRestart(): Promise<boolean> {
    for (let attempt = 1; attempt <= MAX_RESTART_ATTEMPTS; attempt++) {
      if ((await this.meta.get(MOTION_DESIRED_STATE_KEY)) === 'off') {
        // A deliberate stop landed while we were mid-recovery — e.g.
        // /camera disable during the ~2s backoff between attempts. The
        // tick-top gate can't catch this, and a restart that wins here
        // sticks: the healthy path never consults desired state again.
        this.degraded = false;
        return true;
      }
      try {
        await this.motion.restart();
        if (await this.motion.isActive()) {
          this.logger.log(`Motion daemon restarted (attempt ${attempt})`);
          return true;
        }
      } catch (error) {
        this.logger.warn(
          `Motion restart attempt ${attempt} failed: ${(error as Error).message}`,
        );
      }
      if (attempt < MAX_RESTART_ATTEMPTS) await this.sleep(RESTART_BACKOFF_MS);
    }
    return false;
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

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
