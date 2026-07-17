import { describe, expect, it, vi } from 'vitest';
import { InviteHandler } from '../../../src/telegram/interfaces/invite.handler';

describe('InviteHandler contextual workflow', () => {
  it('uses the captured launch and delivers the issued invite before completion', async () => {
    const receipt = { id: 'abcdefghijklmnop' };
    const navigation = { complete: vi.fn(async (_ctx, launch, presentation) => {
      await presentation.deliver();
      expect(launch.receipt).toBe(receipt);
    }) };
    const handler = new InviteHandler(
      { execute: vi.fn().mockResolvedValue({ code: 'abc123' }) } as never,
      {} as never,
      {} as never,
      navigation as never,
    );
    const ctx = { from: { id: 42 }, reply: vi.fn().mockResolvedValue(undefined) };

    await handler.handleCommand(ctx as never, { receipt } as never);

    expect(ctx.reply).toHaveBeenCalledOnce();
    expect(navigation.complete).toHaveBeenCalledOnce();
  });
});
