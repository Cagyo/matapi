import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { Pm2ProcessRestarter } from '../../../src/system/infrastructure/pm2-process-restarter.adapter';

function child() {
  return Object.assign(new EventEmitter(), { unref: vi.fn() });
}

describe('Pm2ProcessRestarter', () => {
  it('resolves and detaches only after the child reports spawn', async () => {
    const spawned = child();
    const spawn = vi.fn().mockReturnValue(spawned);
    const restarter = new Pm2ProcessRestarter(spawn as never);

    const pending = restarter.restart();
    expect(spawned.unref).not.toHaveBeenCalled();
    spawned.emit('spawn');

    await expect(pending).resolves.toBeUndefined();
    expect(spawn).toHaveBeenCalledWith('pm2', ['restart', 'worker'], {
      detached: true,
      stdio: 'ignore',
    });
    expect(spawned.unref).toHaveBeenCalledOnce();
  });

  it('rejects a launch error without detaching the child', async () => {
    const spawned = child();
    const restarter = new Pm2ProcessRestarter(vi.fn().mockReturnValue(spawned) as never);
    const failure = new Error('pm2 unavailable');

    const pending = restarter.restart();
    spawned.emit('error', failure);

    await expect(pending).rejects.toBe(failure);
    expect(spawned.unref).not.toHaveBeenCalled();
  });

  it('keeps an error listener after spawn so a late child error is safe', async () => {
    const spawned = child();
    const restarter = new Pm2ProcessRestarter(vi.fn().mockReturnValue(spawned) as never);

    const pending = restarter.restart();
    spawned.emit('spawn');
    await pending;

    expect(() => spawned.emit('error', new Error('late child error'))).not.toThrow();
  });
});
