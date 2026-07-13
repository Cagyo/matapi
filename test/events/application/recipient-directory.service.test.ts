import { describe, expect, it } from 'vitest';
import { RecipientDirectoryService } from '../../../src/events/application/recipient-directory.service';
import { RecipientDirectoryPort } from '../../../src/events/domain/ports/recipient.port';

const stub: RecipientDirectoryPort = {
  listRecipients: async () => [
    {
      telegramId: 1,
      muted: false,
      nonCriticalPausedUntil: null,
      quietStart: null,
      quietEnd: null,
    },
  ],
  isSensorMuted: async (telegramId, sensorId) =>
    telegramId === 1 && sensorId === 'front_door',
};

describe('RecipientDirectoryService', () => {
  it('reports no recipients before an adapter is registered', async () => {
    const service = new RecipientDirectoryService();
    expect(await service.listRecipients()).toEqual([]);
    expect(await service.isSensorMuted(1, 'front_door')).toBe(false);
  });

  it('delegates to the registered adapter', async () => {
    const service = new RecipientDirectoryService();
    service.register(stub);

    expect(await service.listRecipients()).toHaveLength(1);
    expect(await service.isSensorMuted(1, 'front_door')).toBe(true);
    expect(await service.isSensorMuted(1, 'back_door')).toBe(false);
  });

  it('reverts to the empty directory after clear()', async () => {
    const service = new RecipientDirectoryService();
    service.register(stub);
    service.clear();

    expect(await service.listRecipients()).toEqual([]);
  });
});
