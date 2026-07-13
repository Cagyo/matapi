import { describe, expect, it, vi } from 'vitest';
import { StreamEgressGrant } from '../../../src/camera/domain/stream-egress-grant.value-object';
import { NftStreamEgressAdapter } from '../../../src/camera/infrastructure/nft-stream-egress.adapter';

const now = 1_700_000_000_000;
const sessionId = '01901f4c-b7f4-4c6a-a787-3f8a442c85d2';

describe('NftStreamEgressAdapter', () => {
  it('sends only the validated structured grant and exact opaque lease revoke', async () => {
    const helper = { request: vi.fn(async (request: { op: string }) => request.op === 'grant' ? { ok: true, leaseId: '6d0c4099f4df24314a6f6d17c8d39b59' } : { ok: true }) };
    const adapter = new NftStreamEgressAdapter(helper);
    const grant = StreamEgressGrant.create({
      sessionId, nonceHash: 'ab'.repeat(32), addresses: ['192.168.1.20', 'fd00::20'],
      rtspControlPorts: [554], transport: 'udp', udpMediaPorts: { first: 24_000, last: 24_001 },
      expiresAtUnixMs: now + 30_000,
    }, now);

    const lease = await adapter.grant(grant);
    await adapter.revoke(lease);

    expect(helper.request).toHaveBeenNthCalledWith(1, {
      op: 'grant', sessionId, nonceHash: 'ab'.repeat(32), addresses: ['192.168.1.20', 'fd00::20'],
      rtspControlPorts: [554], transport: 'udp', udpMediaPorts: { first: 24_000, last: 24_001 },
      expiresAtUnixMs: now + 30_000,
    });
    expect(helper.request).toHaveBeenNthCalledWith(2, { op: 'revoke', sessionId, leaseId: lease.leaseId });
  });

  it('maps malformed or secret-bearing helper failures to a sanitized error', async () => {
    const helper = { request: vi.fn(async () => { throw new Error('rtsp://user:pass@camera'); }) };
    const adapter = new NftStreamEgressAdapter(helper);
    const grant = StreamEgressGrant.create({ sessionId, nonceHash: 'ab'.repeat(32), addresses: ['192.168.1.20'], rtspControlPorts: [554], transport: 'tcp', expiresAtUnixMs: now + 30_000 }, now);
    await expect(adapter.grant(grant)).rejects.toThrow('stream egress unavailable');
  });
});
