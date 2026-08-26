import { describe, expect, it, vi } from 'vitest';
import type { RtspSourcePolicyNetwork } from '../../../src/camera/domain/ports/live-source-policy-evaluator.port';
import { SystemLiveSourcePolicyEvaluatorAdapter } from '../../../src/camera/infrastructure/system-live-source-policy-evaluator.adapter';

const LAN: RtspSourcePolicyNetwork = { family: 4, cidr: '192.168.1.0/24', interface: 'eth0' };
const LAN6: RtspSourcePolicyNetwork = { family: 6, cidr: '2001:db8::/32', interface: 'eth0' };

function answers(...addresses: string[]) {
  return addresses.map((address) => ({
    address,
    family: address.includes(':') ? 6 : 4,
  }));
}

function evaluator(lookup = vi.fn()) {
  return {
    lookup,
    adapter: new SystemLiveSourcePolicyEvaluatorAdapter({ lookup }),
  };
}

describe('SystemLiveSourcePolicyEvaluatorAdapter', () => {
  it('allows an in-policy IPv4 literal without resolving anything', async () => {
    const { adapter, lookup } = evaluator();
    await expect(adapter.evaluate('192.168.1.5', { networks: [LAN] })).resolves.toBe('allowed');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('blocks an IPv4 literal outside every policy network', async () => {
    const { adapter } = evaluator();
    await expect(adapter.evaluate('10.0.0.5', { networks: [LAN] })).resolves.toBe('blocked');
  });

  it('allows an in-policy IPv6 literal, brackets and port included', async () => {
    const { adapter, lookup } = evaluator();
    await expect(
      adapter.evaluate('[2001:db8::5]:554', { networks: [LAN6] }),
    ).resolves.toBe('allowed');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('blocks an IPv6 literal under an IPv4-only policy', async () => {
    const { adapter } = evaluator();
    await expect(adapter.evaluate('[2001:db8::5]:554', { networks: [LAN] })).resolves.toBe('blocked');
  });

  it('resolves the bare hostname, dropping the port', async () => {
    const lookup = vi.fn().mockResolvedValue(answers('192.168.1.9'));
    const { adapter } = evaluator(lookup);
    await expect(adapter.evaluate('cam.local:554', { networks: [LAN] })).resolves.toBe('allowed');
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith('cam.local');
  });

  it('allows a hostname whose every answer sits inside the policy', async () => {
    const lookup = vi.fn().mockResolvedValue(answers('192.168.1.9', '192.168.1.10'));
    const { adapter } = evaluator(lookup);
    await expect(adapter.evaluate('cam.local', { networks: [LAN] })).resolves.toBe('allowed');
  });

  it('blocks a hostname when a single answer sits outside the policy', async () => {
    const lookup = vi.fn().mockResolvedValue(answers('192.168.1.9', '203.0.113.7'));
    const { adapter } = evaluator(lookup);
    await expect(adapter.evaluate('cam.local', { networks: [LAN] })).resolves.toBe('blocked');
  });

  it('normalizes an IPv4-mapped IPv6 answer before comparing it', async () => {
    const lookup = vi.fn().mockResolvedValue(answers('::ffff:192.168.1.9'));
    const { adapter } = evaluator(lookup);
    await expect(adapter.evaluate('cam.local', { networks: [LAN] })).resolves.toBe('allowed');
  });

  it('blocks a mapped IPv4 answer that lands outside the IPv4 policy', async () => {
    const lookup = vi.fn().mockResolvedValue(answers('::ffff:203.0.113.7'));
    const { adapter } = evaluator(lookup);
    await expect(adapter.evaluate('cam.local', { networks: [LAN, LAN6] })).resolves.toBe('blocked');
  });

  it('reports unresolved when the resolver rejects', async () => {
    const lookup = vi.fn().mockRejectedValue(new Error('ENOTFOUND cam.local'));
    const { adapter } = evaluator(lookup);
    await expect(adapter.evaluate('cam.local', { networks: [LAN] })).resolves.toBe('unresolved');
  });

  it('reports unresolved when the resolver answers with nothing', async () => {
    const lookup = vi.fn().mockResolvedValue([]);
    const { adapter } = evaluator(lookup);
    await expect(adapter.evaluate('cam.local', { networks: [LAN] })).resolves.toBe('unresolved');
  });

  it('blocks rather than truncates an answer list beyond the cap', async () => {
    const flood = Array.from({ length: 9 }, (_, index) => `192.168.1.${index + 1}`);
    const lookup = vi.fn().mockResolvedValue(answers(...flood));
    const { adapter } = evaluator(lookup);
    await expect(adapter.evaluate('cam.local', { networks: [LAN] })).resolves.toBe('blocked');
  });

  it('reflects a rebinding answer on the next call instead of caching', async () => {
    const lookup = vi
      .fn()
      .mockResolvedValueOnce(answers('192.168.1.9'))
      .mockResolvedValueOnce(answers('203.0.113.7'));
    const { adapter } = evaluator(lookup);
    await expect(adapter.evaluate('cam.local', { networks: [LAN] })).resolves.toBe('allowed');
    await expect(adapter.evaluate('cam.local', { networks: [LAN] })).resolves.toBe('blocked');
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('blocks against an empty policy without resolving anything', async () => {
    const { adapter, lookup } = evaluator();
    await expect(adapter.evaluate('cam.local', { networks: [] })).resolves.toBe('blocked');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('ignores an unusable policy entry while honouring its valid siblings', async () => {
    const { adapter } = evaluator();
    const networks: RtspSourcePolicyNetwork[] = [
      { family: 4, cidr: 'not-a-network', interface: 'eth0' },
      { family: 4, cidr: '192.168.1.5/24', interface: 'eth0' },
      { family: 4, cidr: '10.0.0.0/4', interface: 'eth0' },
      { family: 6, cidr: '192.168.2.0/24', interface: 'eth0' },
      LAN,
    ];
    await expect(adapter.evaluate('192.168.1.5', { networks })).resolves.toBe('allowed');
    await expect(adapter.evaluate('192.168.2.5', { networks })).resolves.toBe('blocked');
    await expect(adapter.evaluate('10.1.2.3', { networks })).resolves.toBe('blocked');
  });

  it('blocks an answer it cannot canonicalize', async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: 'fe80::1%eth0', family: 6 }]);
    const { adapter } = evaluator(lookup);
    await expect(adapter.evaluate('cam.local', { networks: [LAN6] })).resolves.toBe('blocked');
  });

  it('reports unresolved for a host it cannot parse', async () => {
    const { adapter, lookup } = evaluator();
    await expect(adapter.evaluate('not a host', { networks: [LAN] })).resolves.toBe('unresolved');
    expect(lookup).not.toHaveBeenCalled();
  });
});
