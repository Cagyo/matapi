import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MotionWatcherService } from '../../../src/camera/application/motion-watcher.service';
import { CameraMode } from '../../../src/camera/camera.tokens';
import { MOTION_DESIRED_STATE_KEY } from '../../../src/camera/domain/motion-desired-state';
import {
  AdminAlertPort,
  CameraAdminAlert,
} from '../../../src/camera/domain/ports/admin-alert.port';
import { MotionControlPort } from '../../../src/camera/domain/ports/motion-control.port';
import { SystemMetaRepositoryPort } from '../../../src/system/domain/ports/system-meta-repository.port';

class FakeMotion implements MotionControlPort {
  active: boolean;
  restartSucceeds = true;
  restartCalls = 0;
  constructor(active: boolean) {
    this.active = active;
  }
  async start(): Promise<void> {
    this.active = true;
  }
  async stop(): Promise<void> {
    this.active = false;
  }
  async restart(): Promise<void> {
    this.restartCalls++;
    if (this.restartSucceeds) this.active = true;
  }
  async isActive(): Promise<boolean> {
    return this.active;
  }
}

class RecordingAdminAlert implements AdminAlertPort {
  readonly alerts: CameraAdminAlert[] = [];
  async alert(kind: CameraAdminAlert): Promise<void> {
    this.alerts.push(kind);
  }
}

function memMeta(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const meta: SystemMetaRepositoryPort = {
    get: async (key) => store.get(key) ?? null,
    set: async (key, value) => void store.set(key, value),
    delete: async (key) => void store.delete(key),
  };
  return { meta, store };
}

function tick(watcher: MotionWatcherService): Promise<void> {
  return (watcher as unknown as { tick(): Promise<void> }).tick();
}

function build(
  motion: FakeMotion,
  mode: CameraMode = 'real',
  desired: 'on' | 'off' | null = null,
) {
  const admin = new RecordingAdminAlert();
  const { meta, store } = memMeta(
    desired ? { [MOTION_DESIRED_STATE_KEY]: desired } : {},
  );
  const watcher = new MotionWatcherService(mode, motion, admin, meta);
  return { watcher, admin, store };
}

describe('MotionWatcherService', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does nothing while the daemon is healthy', async () => {
    const motion = new FakeMotion(true);
    const { watcher, admin } = build(motion);

    await tick(watcher);

    expect(motion.restartCalls).toBe(0);
    expect(admin.alerts).toHaveLength(0);
  });

  it('restarts a downed daemon and stays silent on success', async () => {
    const motion = new FakeMotion(false);
    motion.restartSucceeds = true;
    const { watcher, admin } = build(motion);

    await tick(watcher);

    expect(motion.restartCalls).toBe(1);
    expect(motion.active).toBe(true);
    expect(admin.alerts).toHaveLength(0);
    expect(watcher.isDegraded()).toBe(false);
  });

  it('alerts admins once after exhausting restarts', async () => {
    const motion = new FakeMotion(false);
    motion.restartSucceeds = false;
    const { watcher, admin } = build(motion);

    const first = tick(watcher);
    await vi.runAllTimersAsync();
    await first;

    expect(motion.restartCalls).toBe(3);
    expect(admin.alerts).toEqual(['motion-daemon-down']);
    expect(watcher.isDegraded()).toBe(true);

    // A second failing tick does not re-alert.
    const second = tick(watcher);
    await vi.runAllTimersAsync();
    await second;
    expect(admin.alerts).toEqual(['motion-daemon-down']);
  });

  it('emits a recovery alert once the daemon comes back', async () => {
    const motion = new FakeMotion(false);
    motion.restartSucceeds = false;
    const { watcher, admin } = build(motion);

    const down = tick(watcher);
    await vi.runAllTimersAsync();
    await down;
    expect(admin.alerts).toEqual(['motion-daemon-down']);

    motion.active = true;
    await tick(watcher);

    expect(admin.alerts).toEqual(['motion-daemon-down', 'motion-daemon-recovered']);
    expect(watcher.isDegraded()).toBe(false);
  });

  it('does not start a timer in stub mode', () => {
    const motion = new FakeMotion(true);
    const { watcher } = build(motion, 'stub');
    const spy = vi.spyOn(global, 'setInterval');

    watcher.onApplicationBootstrap();

    expect(spy).not.toHaveBeenCalled();
  });

  it('leaves a deliberately stopped daemon alone (desired=off)', async () => {
    const motion = new FakeMotion(false);
    const { watcher, admin } = build(motion, 'real', 'off');

    await tick(watcher);

    expect(motion.restartCalls).toBe(0);
    expect(admin.alerts).toHaveLength(0);
    expect(watcher.isDegraded()).toBe(false);
  });

  it('clears a stale degraded flag without alerting when desired=off', async () => {
    const motion = new FakeMotion(false);
    motion.restartSucceeds = false;
    const { watcher, admin, store } = build(motion, 'real', 'on');

    const down = tick(watcher);
    await vi.runAllTimersAsync();
    await down;
    expect(watcher.isDegraded()).toBe(true);

    // Admin gives up and disables the camera; watcher must stand down silently.
    store.set(MOTION_DESIRED_STATE_KEY, 'off');
    await tick(watcher);

    expect(watcher.isDegraded()).toBe(false);
    expect(admin.alerts).toEqual(['motion-daemon-down']); // no recovery alert
  });

  it('aborts mid-backoff restarts when disable lands during recovery', async () => {
    // Race: the tick-top gate read desired=on, then /camera disable lands
    // while tryRestart sleeps between attempts (~2s backoff). Without a
    // re-check before each attempt, the restart wins - and the healthy path
    // never consults desired state, so the daemon stays up despite disable.
    const motion = new FakeMotion(false);
    motion.restartSucceeds = false;
    const { watcher, admin, store } = build(motion, 'real', 'on');

    const ticking = tick(watcher);
    await vi.advanceTimersByTimeAsync(0); // let restart attempt 1 fail
    expect(motion.restartCalls).toBe(1);
    store.set(MOTION_DESIRED_STATE_KEY, 'off'); // admin disables mid-backoff
    await vi.runAllTimersAsync();
    await ticking;

    expect(motion.restartCalls).toBe(1); // attempts 2 and 3 never fire
    expect(admin.alerts).toEqual([]); // deliberate stop - no failure alert
    expect(watcher.isDegraded()).toBe(false);
  });
});
