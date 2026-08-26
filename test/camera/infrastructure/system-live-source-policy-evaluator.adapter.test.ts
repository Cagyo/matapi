import { afterEach, describe, expect, it, vi } from 'vitest';
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

function evaluator(lookup = vi.fn(), timeoutMs?: number) {
  return {
    lookup,
    adapter: new SystemLiveSourcePolicyEvaluatorAdapter(
      timeoutMs === undefined ? { lookup } : { lookup, timeoutMs },
    ),
  };
}

describe('SystemLiveSourcePolicyEvaluatorAdapter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows an in-policy IPv4 literal without resolving anything', async () => {
    const { adapter, lookup } = evaluator();
    await expect(adapter.evaluate(['192.168.1.5'], { networks: [LAN] })).resolves.toBe('allowed');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('blocks an IPv4 literal outside every policy network', async () => {
    const { adapter } = evaluator();
    await expect(adapter.evaluate(['10.0.0.5'], { networks: [LAN] })).resolves.toBe('blocked');
  });

  it('allows an in-policy IPv6 literal, brackets and port included', async () => {
    const { adapter, lookup } = evaluator();
    await expect(
      adapter.evaluate(['[2001:db8::5]:554'], { networks: [LAN6] }),
    ).resolves.toBe('allowed');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('blocks an IPv6 literal under an IPv4-only policy', async () => {
    const { adapter } = evaluator();
    await expect(adapter.evaluate(['[2001:db8::5]:554'], { networks: [LAN] })).resolves.toBe('blocked');
  });

  it('resolves the bare hostname, dropping the port', async () => {
    const lookup = vi.fn().mockResolvedValue(answers('192.168.1.9'));
    const { adapter } = evaluator(lookup);
    await expect(adapter.evaluate(['cam.local:554'], { networks: [LAN] })).resolves.toBe('allowed');
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith('cam.local');
  });

  it('allows a hostname whose every answer sits inside the policy', async () => {
    const lookup = vi.fn().mockResolvedValue(answers('192.168.1.9', '192.168.1.10'));
    const { adapter } = evaluator(lookup);
    await expect(adapter.evaluate(['cam.local'], { networks: [LAN] })).resolves.toBe('allowed');
  });

  it('blocks a hostname when a single answer sits outside the policy', async () => {
    const lookup = vi.fn().mockResolvedValue(answers('192.168.1.9', '203.0.113.7'));
    const { adapter } = evaluator(lookup);
    await expect(adapter.evaluate(['cam.local'], { networks: [LAN] })).resolves.toBe('blocked');
  });

  it('normalizes an IPv4-mapped IPv6 answer before comparing it', async () => {
    const lookup = vi.fn().mockResolvedValue(answers('::ffff:192.168.1.9'));
    const { adapter } = evaluator(lookup);
    await expect(adapter.evaluate(['cam.local'], { networks: [LAN] })).resolves.toBe('allowed');
  });

  it('blocks a mapped IPv4 answer that lands outside the IPv4 policy', async () => {
    const lookup = vi.fn().mockResolvedValue(answers('::ffff:203.0.113.7'));
    const { adapter } = evaluator(lookup);
    await expect(adapter.evaluate(['cam.local'], { networks: [LAN, LAN6] })).resolves.toBe('blocked');
  });

  it('reports unresolved when the resolver rejects', async () => {
    const lookup = vi.fn().mockRejectedValue(new Error('ENOTFOUND cam.local'));
    const { adapter } = evaluator(lookup);
    await expect(adapter.evaluate(['cam.local'], { networks: [LAN] })).resolves.toBe('unresolved');
  });

  it('reports unresolved when the resolver answers with nothing', async () => {
    const lookup = vi.fn().mockResolvedValue([]);
    const { adapter } = evaluator(lookup);
    await expect(adapter.evaluate(['cam.local'], { networks: [LAN] })).resolves.toBe('unresolved');
  });

  it('reflects a rebinding answer on the next call instead of caching', async () => {
    const lookup = vi
      .fn()
      .mockResolvedValueOnce(answers('192.168.1.9'))
      .mockResolvedValueOnce(answers('203.0.113.7'));
    const { adapter } = evaluator(lookup);
    await expect(adapter.evaluate(['cam.local'], { networks: [LAN] })).resolves.toBe('allowed');
    await expect(adapter.evaluate(['cam.local'], { networks: [LAN] })).resolves.toBe('blocked');
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('blocks against an empty policy without resolving anything', async () => {
    const { adapter, lookup } = evaluator();
    await expect(adapter.evaluate(['cam.local'], { networks: [] })).resolves.toBe('blocked');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('blocks a source that offers no host at all', async () => {
    const { adapter, lookup } = evaluator();
    await expect(adapter.evaluate([], { networks: [LAN] })).resolves.toBe('blocked');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('ignores an unusable policy entry while honouring its valid siblings', async () => {
    const { adapter } = evaluator();
    const networks = [
      { family: 4, cidr: 'not-a-network', interface: 'eth0' },
      { family: 4, cidr: '192.168.1.5/24', interface: 'eth0' },
      { family: 4, cidr: '10.0.0.0/4', interface: 'eth0' },
      { family: 6, cidr: '192.168.2.0/24', interface: 'eth0' },
      LAN,
    ] as RtspSourcePolicyNetwork[];
    await expect(adapter.evaluate(['192.168.1.5'], { networks })).resolves.toBe('allowed');
    await expect(adapter.evaluate(['192.168.2.5'], { networks })).resolves.toBe('blocked');
    await expect(adapter.evaluate(['10.1.2.3'], { networks })).resolves.toBe('blocked');
  });

  it('blocks an answer it cannot canonicalize', async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: 'fe80::1%eth0', family: 6 }]);
    const { adapter } = evaluator(lookup);
    await expect(adapter.evaluate(['cam.local'], { networks: [LAN6] })).resolves.toBe('blocked');
  });

  it('blocks an answer that is not a string at all', async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: undefined, family: 4 }]);
    const { adapter } = evaluator(lookup);
    await expect(adapter.evaluate(['cam.local'], { networks: [LAN] })).resolves.toBe('blocked');
  });

  it('reports unresolved for a host it cannot parse', async () => {
    const { adapter, lookup } = evaluator();
    await expect(adapter.evaluate(['not a host'], { networks: [LAN] })).resolves.toBe('unresolved');
    expect(lookup).not.toHaveBeenCalled();
  });

  describe('distinct-address ceiling', () => {
    it('allows a host at the ceiling the probe also permits', async () => {
      const lookup = vi.fn().mockResolvedValue(answers('192.168.1.9', '192.168.1.10'));
      const { adapter } = evaluator(lookup);
      await expect(adapter.evaluate(['cam.local'], { networks: [LAN] })).resolves.toBe('allowed');
    });

    it('blocks the first host one address beyond the ceiling', async () => {
      const lookup = vi
        .fn()
        .mockResolvedValue(answers('192.168.1.9', '192.168.1.10', '192.168.1.11'));
      const { adapter } = evaluator(lookup);
      await expect(adapter.evaluate(['cam.local'], { networks: [LAN] })).resolves.toBe('blocked');
    });

    it('deduplicates repeated answers before applying the ceiling', async () => {
      const lookup = vi
        .fn()
        .mockResolvedValue(
          answers('192.168.1.9', '192.168.1.9', '::ffff:192.168.1.9', '192.168.1.10'),
        );
      const { adapter } = evaluator(lookup);
      await expect(adapter.evaluate(['cam.local'], { networks: [LAN] })).resolves.toBe('allowed');
    });
  });

  describe('multiple hosts', () => {
    it('allows a source whose every host resolves inside the policy', async () => {
      const lookup = vi
        .fn()
        .mockResolvedValueOnce(answers('192.168.1.9'))
        .mockResolvedValueOnce(answers('192.168.1.10'));
      const { adapter } = evaluator(lookup);
      await expect(
        adapter.evaluate(['cam.local', 'sub.local'], { networks: [LAN] }),
      ).resolves.toBe('allowed');
      expect(lookup).toHaveBeenCalledTimes(2);
    });

    it('lets a blocked substream outrank an allowed primary', async () => {
      const lookup = vi
        .fn()
        .mockResolvedValueOnce(answers('192.168.1.9'))
        .mockResolvedValueOnce(answers('203.0.113.7'));
      const { adapter } = evaluator(lookup);
      await expect(
        adapter.evaluate(['cam.local', 'sub.local'], { networks: [LAN] }),
      ).resolves.toBe('blocked');
    });

    it('lets an unresolved substream outrank an allowed primary', async () => {
      const lookup = vi
        .fn()
        .mockResolvedValueOnce(answers('192.168.1.9'))
        .mockRejectedValueOnce(new Error('ENOTFOUND sub.local'));
      const { adapter } = evaluator(lookup);
      await expect(
        adapter.evaluate(['cam.local', 'sub.local'], { networks: [LAN] }),
      ).resolves.toBe('unresolved');
    });

    it('lets a blocked host outrank an unresolved one', async () => {
      const lookup = vi
        .fn()
        .mockRejectedValueOnce(new Error('ENOTFOUND cam.local'))
        .mockResolvedValueOnce(answers('203.0.113.7'));
      const { adapter } = evaluator(lookup);
      await expect(
        adapter.evaluate(['cam.local', 'sub.local'], { networks: [LAN] }),
      ).resolves.toBe('blocked');
    });

    it('resolves one hostname once however many ports address it', async () => {
      // The realistic substream shape: same camera, second port. Deduping on
      // the raw authority would miss it and resolve `cam.local` twice.
      const lookup = vi.fn().mockResolvedValue(answers('192.168.1.9'));
      const { adapter } = evaluator(lookup);
      await expect(
        adapter.evaluate(['cam.local:554', 'cam.local:8554'], { networks: [LAN] }),
      ).resolves.toBe('allowed');
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(lookup).toHaveBeenCalledWith('cam.local');
    });

    it('still reports an unparsable host alongside a resolvable one', async () => {
      const lookup = vi.fn().mockResolvedValue(answers('192.168.1.9'));
      const { adapter } = evaluator(lookup);
      await expect(
        adapter.evaluate(['cam.local', 'not a host'], { networks: [LAN] }),
      ).resolves.toBe('unresolved');
      expect(lookup).toHaveBeenCalledTimes(1);
    });

    it('resolves a repeated host only once', async () => {
      const lookup = vi.fn().mockResolvedValue(answers('192.168.1.9'));
      const { adapter } = evaluator(lookup);
      await expect(
        adapter.evaluate(['cam.local', 'cam.local'], { networks: [LAN] }),
      ).resolves.toBe('allowed');
      expect(lookup).toHaveBeenCalledTimes(1);
    });
  });

  describe('resolver deadline', () => {
    it('gives up on a resolver that never settles', async () => {
      vi.useFakeTimers();
      const lookup = vi.fn().mockReturnValue(new Promise(() => {}));
      const { adapter } = evaluator(lookup, 5_000);

      const relationship = adapter.evaluate(['cam.local'], { networks: [LAN] });
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(relationship).resolves.toBe('unresolved');
    });

    it('keeps the answer of a resolver that beats the deadline', async () => {
      vi.useFakeTimers();
      const lookup = vi.fn().mockResolvedValue(answers('192.168.1.9'));
      const { adapter } = evaluator(lookup, 5_000);

      const relationship = adapter.evaluate(['cam.local'], { networks: [LAN] });
      await vi.advanceTimersByTimeAsync(1);

      await expect(relationship).resolves.toBe('allowed');
    });

    it('spends one shared budget across every host', async () => {
      vi.useFakeTimers();
      const lookup = vi
        .fn()
        .mockResolvedValueOnce(answers('192.168.1.9'))
        .mockReturnValueOnce(new Promise(() => {}));
      const { adapter } = evaluator(lookup, 5_000);

      const relationship = adapter.evaluate(['cam.local', 'sub.local'], { networks: [LAN] });
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(relationship).resolves.toBe('unresolved');
    });
  });
});
