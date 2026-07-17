import { describe, expect, it, vi } from 'vitest';
import { HelpHandler } from '../../../src/telegram/interfaces/help.handler';

describe('HelpHandler contextual workflow', () => {
  it('starts a direct help receipt from the More natural parent', async () => {
    const receipt = { id: 'abcdefghijklmnop' };
    const workflows = { begin: vi.fn().mockResolvedValue(receipt) };
    const handler = new HelpHandler({} as never, workflows as never, undefined);
    const ctx = {
      from: { id: 42 },
      chat: { id: 42, type: 'private' },
      localeState: { user: { role: 'user' }, catalog: { help: { user: 'Help' } } },
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await (handler as unknown as { handleCommand(context: typeof ctx): Promise<void> }).handleCommand(ctx);

    expect(workflows.begin).toHaveBeenCalledWith(ctx, 'help', { source: 'natural-parent' });
  });
});
