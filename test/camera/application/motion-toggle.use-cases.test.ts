import { describe, expect, it } from 'vitest';
import { DisableMotionUseCase } from '../../../src/camera/application/disable-motion.use-case';
import { EnableMotionUseCase } from '../../../src/camera/application/enable-motion.use-case';
import { MOTION_DESIRED_STATE_KEY } from '../../../src/camera/domain/motion-desired-state';
import { MotionAlreadyRunningError } from '../../../src/camera/domain/errors/motion-already-running.error';
import { MotionControlPort } from '../../../src/camera/domain/ports/motion-control.port';
import { SystemMetaRepositoryPort } from '../../../src/system/domain/ports/system-meta-repository.port';

function memMeta(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const meta: SystemMetaRepositoryPort = {
    get: async (key) => store.get(key) ?? null,
    set: async (key, value) => void store.set(key, value),
    delete: async (key) => void store.delete(key),
  };
  return { meta, store };
}

class FakeMotion implements MotionControlPort {
  constructor(public active: boolean) {}
  async start(): Promise<void> {
    if (this.active) throw new MotionAlreadyRunningError();
    this.active = true;
  }
  async stop(): Promise<void> {
    this.active = false;
  }
  async restart(): Promise<void> {
    this.active = true;
  }
  async isActive(): Promise<boolean> {
    return this.active;
  }
}

describe('Enable/DisableMotionUseCase desired state', () => {
  it('enable records desired=on, then starts the daemon', async () => {
    const motion = new FakeMotion(false);
    const { meta, store } = memMeta();

    await new EnableMotionUseCase(motion, meta).execute();

    expect(store.get(MOTION_DESIRED_STATE_KEY)).toBe('on');
    expect(motion.active).toBe(true);
  });

  it('enable records intent even when the daemon is already running', async () => {
    const motion = new FakeMotion(true);
    const { meta, store } = memMeta({ [MOTION_DESIRED_STATE_KEY]: 'off' });

    await expect(new EnableMotionUseCase(motion, meta).execute()).rejects.toBeInstanceOf(
      MotionAlreadyRunningError,
    );

    // Intent is recorded before the start attempt, so a watcher-guarded
    // daemon that is somehow running again becomes "wanted" once more.
    expect(store.get(MOTION_DESIRED_STATE_KEY)).toBe('on');
  });

  it('disable records desired=off, then stops the daemon', async () => {
    const motion = new FakeMotion(true);
    const { meta, store } = memMeta();

    await new DisableMotionUseCase(motion, meta).execute();

    expect(store.get(MOTION_DESIRED_STATE_KEY)).toBe('off');
    expect(motion.active).toBe(false);
  });
});
