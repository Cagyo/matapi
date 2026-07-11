import { describe, expect, it, vi } from 'vitest';
import { MuteHandler } from '../../../src/telegram/interfaces/mute.handler';
import { SensorAlreadyMutedError } from '../../../src/telegram/domain/errors/sensor-already-muted.error';
import { en } from '../../../src/locales/en';

describe('MuteHandler', () => {
  it('handleMuteAll mutes all enabled sensors and replies with count', async () => {
    const sensors = {
      listEnabled: vi.fn().mockResolvedValue([
        { name: 'front_door', type: 'digital' },
        { name: 'motion', type: 'digital' },
      ]),
    } as any;
    const mute = { execute: vi.fn().mockResolvedValue(undefined) } as any;
    const guard = { registered: vi.fn() } as any;

    const handler = new MuteHandler(sensors, mute, guard);
    const reply = vi.fn().mockResolvedValue(true);
    const ctx = { from: { id: 123 }, reply } as any;

    await handler.handleMuteAll(ctx);
    expect(sensors.listEnabled).toHaveBeenCalledTimes(1);
    expect(mute.execute).toHaveBeenCalledTimes(2);
    expect(mute.execute).toHaveBeenCalledWith(123, 'front_door');
    expect(mute.execute).toHaveBeenCalledWith(123, 'motion');
    expect(reply).toHaveBeenCalledWith(en.mute.mutedAll(2));
  });

  it('handleMuteAll handles already muted sensors gracefully', async () => {
    const sensors = {
      listEnabled: vi.fn().mockResolvedValue([
        { name: 'front_door', type: 'digital' },
        { name: 'motion', type: 'digital' },
      ]),
    } as any;
    const mute = {
      execute: vi.fn().mockImplementation((_user, name) => {
        if (name === 'front_door') return Promise.reject(new SensorAlreadyMutedError('front_door'));
        return Promise.resolve();
      }),
    } as any;
    const guard = { registered: vi.fn() } as any;

    const handler = new MuteHandler(sensors, mute, guard);
    const reply = vi.fn().mockResolvedValue(true);
    const ctx = { from: { id: 123 }, reply } as any;

    await handler.handleMuteAll(ctx);
    expect(reply).toHaveBeenCalledWith(en.mute.mutedAll(1));
  });

  it('handleMuteAll mutes cameras when media repository is provided', async () => {
    const sensors = {
      listEnabled: vi.fn().mockResolvedValue([]),
    } as any;
    const mute = { execute: vi.fn().mockResolvedValue(undefined) } as any;
    const guard = { registered: vi.fn() } as any;
    const media = {
      listCameras: vi.fn().mockResolvedValue([
        { id: 'cam-1', name: 'front_door_cam', enabled: true },
      ]),
    } as any;

    const handler = new MuteHandler(sensors, mute, guard, media);
    const reply = vi.fn().mockResolvedValue(true);
    const ctx = { from: { id: 123 }, reply } as any;

    await handler.handleMuteAll(ctx);
    expect(mute.execute).toHaveBeenCalledWith(123, 'front_door_cam');
    expect(reply).toHaveBeenCalledWith(en.mute.mutedAll(1));
  });
});
