import { describe, expect, it } from 'vitest';
import type { ClockPort } from '../../../src/events/domain/ports/clock.port';
import type { ParsedHomeCallback } from '../../../src/telegram/domain/home-callback';
import type { HomeIdentity, ValidateHomeResult } from '../../../src/telegram/domain/home-session';
import type { HomeSessionStorePort } from '../../../src/telegram/domain/ports/home-session-store.port';
import { ValidateHomeCallbackUseCase } from '../../../src/telegram/application/validate-home-callback.use-case';

const NOW = new Date('2030-01-01T00:00:00.000Z');
const parsed: ParsedHomeCallback = {
  token: 'abcdefghijklmnop',
  revision: 7,
  action: { kind: 'sensors', page: 2 },
};

class RecordingStore implements HomeSessionStorePort {
  input: (HomeIdentity & { now: Date }) | null = null;
  result: ValidateHomeResult = { kind: 'closed' };

  async reserveNew(): never { throw new Error('not used'); }
  async reserveEdit(): never { throw new Error('not used'); }
  async promoteNew(): never { throw new Error('not used'); }
  async promoteEdit(): never { throw new Error('not used'); }
  async abandon(): never { throw new Error('not used'); }
  async close(): never { throw new Error('not used'); }

  async validate(input: HomeIdentity & { now: Date }): Promise<ValidateHomeResult> {
    this.input = input;
    return this.result;
  }
}

describe('ValidateHomeCallbackUseCase', () => {
  it('constructs full callback identity from parsed and current Telegram fields', async () => {
    const store = new RecordingStore();
    const clock: ClockPort = { now: () => NOW };
    const useCase = new ValidateHomeCallbackUseCase(store, clock);

    await expect(
      useCase.execute({ parsed, userId: 100, chatId: 200, messageId: 300 }),
    ).resolves.toEqual({ kind: 'closed' });
    expect(store.input).toEqual({
      userId: 100,
      chatId: 200,
      messageId: 300,
      token: parsed.token,
      revision: parsed.revision,
      now: NOW,
    });
  });

  it('propagates storage failures for the interface boundary to recover fail-closed', async () => {
    const store = new RecordingStore();
    store.validate = async () => {
      throw new Error('storage unavailable');
    };
    const useCase = new ValidateHomeCallbackUseCase(store, { now: () => NOW });

    await expect(
      useCase.execute({ parsed, userId: 100, chatId: 200, messageId: 300 }),
    ).rejects.toThrow('storage unavailable');
  });
});
