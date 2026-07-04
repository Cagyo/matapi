import { describe, expect, it, vi } from 'vitest';
import { UnmuteHandler } from '../../../src/telegram/interfaces/unmute.handler';
import { SensorNotMutedError } from '../../../src/telegram/domain/errors/sensor-not-muted.error';
import { en } from '../../../src/locales/en';

describe('UnmuteHandler', () => {
  it('handleUnmuteAll unmutes all enabled sensors and replies with count', async () => {
    const sensors = {
      listEnabled: vi.fn().mockResolvedValue([
        { name: 'front_door', type: 'digital' },
        { name: 'motion', type: 'digital' },
      ]),
    } as any;
    const unmute = { execute: vi.fn().mockResolvedValue(undefined) } as any;
    const guard = { registered: vi.fn() } as any;

    const handler = new UnmuteHandler(sensors, unmute, guard);
    const reply = vi.fn().mockResolvedValue(true);
    const ctx = { from: { id: 123 }, reply } as any;

    await handler.handleUnmuteAll(ctx);
    expect(sensors.listEnabled).toHaveBeenCalledTimes(1);
    expect(unmute.execute).toHaveBeenCalledTimes(2);
    expect(unmute.execute).toHaveBeenCalledWith(123, 'front_door');
    expect(unmute.execute).toHaveBeenCalledWith(123, 'motion');
    expect(reply).toHaveBeenCalledWith(en.mute.unmutedAll(2));
  });
});
