import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MotionWatcherService } from '../../../src/camera/application/motion-watcher.service';
import { CameraMode } from '../../../src/camera/camera.tokens';
import {
  AdminAlertPort,
  CameraAdminAlert,
} from '../../../src/camera/domain/ports/admin-alert.port';
import { MotionControlPort } from '../../../src/camera/domain/ports/motion-control.port';

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

function tick(watcher: MotionWatcherService): Promise<void> {
  return (watcher as unknown as { tick(): Promise<void> }).tick();
}

function build(motion: FakeMotion, mode: CameraMode = 'real') {
  const admin = new RecordingAdminAlert();
  const watcher = new MotionWatcherService(mode, motion, admin);
  return { watcher, admin };
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
});
