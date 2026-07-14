import { describe, expect, it } from 'vitest';
import { InMemoryHomeMessageDeliveryAdapter } from '../../../src/telegram/infrastructure/in-memory-home-message-delivery.adapter';

describe('InMemoryHomeMessageDeliveryAdapter', () => {
  it('bounds retained diagnostic calls', async () => {
    const delivery = new InMemoryHomeMessageDeliveryAdapter();

    for (let messageId = 1; messageId <= 101; messageId += 1) {
      await delivery.stripKeyboard(7, messageId);
    }

    expect(delivery.calls).toHaveLength(100);
    expect(delivery.calls[0]).toMatchObject({ kind: 'stripKeyboard', messageId: 2 });
  });
});
