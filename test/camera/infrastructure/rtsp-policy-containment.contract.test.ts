import { isIP } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import type { RtspSourcePolicyNetwork } from '../../../src/camera/domain/ports/live-source-policy-evaluator.port';
import {
  canonicalAddress,
  contains,
  parseCidrs,
} from '../../../src/camera/infrastructure/ffmpeg-live-source-probe.adapter';
import { SystemLiveSourcePolicyEvaluatorAdapter } from '../../../src/camera/infrastructure/system-live-source-policy-evaluator.adapter';

/**
 * Two CIDR containment implementations decide what "inside the policy" means:
 * the probe's, which enforces it, and the status evaluator's, which reports it.
 * They are separate code (see the evaluator's class comment for why), and a
 * silent divergence between them is exactly the bug that would make the
 * overview promise a stream the probe then refuses.
 *
 * So every row below is run through both. Agreement is the default; the two
 * known, deliberate divergences are listed as such. A third one fails this
 * suite the moment it appears.
 *
 * Both sides are driven through their real entry points — no reimplementation
 * of either — and the policy `family` handed to the evaluator is derived from
 * the CIDR itself, so the evaluator's extra family cross-check (which the probe
 * has no equivalent of) is never what makes the two differ.
 */

interface ContainmentRow {
  address: string;
  cidr: string;
  /** Set only for the two rows where the implementations are meant to differ. */
  divergence?: string;
}

const ROWS: ContainmentRow[] = [
  // --- ordinary IPv4 containment, including the prefix boundaries ---
  { address: '192.168.1.5', cidr: '192.168.1.0/24' },
  { address: '192.168.2.5', cidr: '192.168.1.0/24' },
  { address: '192.168.1.0', cidr: '192.168.1.0/24' },
  { address: '192.168.1.255', cidr: '192.168.1.0/24' },
  { address: '192.168.0.255', cidr: '192.168.1.0/24' },
  { address: '192.168.2.0', cidr: '192.168.1.0/24' },
  { address: '10.255.255.255', cidr: '10.0.0.0/8' },
  { address: '11.0.0.0', cidr: '10.0.0.0/8' },
  { address: '192.168.1.5', cidr: '192.168.1.5/32' },
  { address: '192.168.1.6', cidr: '192.168.1.5/32' },
  { address: '172.16.0.1', cidr: '172.16.0.0/12' },
  { address: '172.32.0.1', cidr: '172.16.0.0/12' },

  // --- policies both implementations must refuse outright ---
  { address: '192.168.1.5', cidr: '0.0.0.0/0' },
  { address: '192.168.1.5', cidr: '10.0.0.0/7' },
  { address: '192.168.1.5', cidr: '192.168.1.5/24' },
  { address: '192.168.1.5', cidr: '192.168.1.0/33' },
  { address: '192.168.1.5', cidr: 'not-a-network/24' },
  { address: '192.168.1.5', cidr: '3232235777/24' },
  { address: '192.168.1.5', cidr: '192.168.1.0' },

  // --- IPv6 containment and its boundaries ---
  { address: '2001:db8::1', cidr: '2001:db8::/32' },
  { address: '2001:db9::1', cidr: '2001:db8::/32' },
  { address: '2001:db8::1', cidr: '2001:db8::1/128' },
  { address: '2001:db8::2', cidr: '2001:db8::1/128' },
  { address: '2001:0db8:0000:0000:0000:0000:0000:0001', cidr: '2001:db8::/32' },
  { address: 'fd00::1', cidr: 'fd00::/8' },
  { address: 'fe00::1', cidr: 'fd00::/8' },
  { address: '::1', cidr: '::/8' },

  // --- cross-family, which both must fail closed on ---
  { address: '2001:db8::1', cidr: '192.168.1.0/24' },
  { address: '192.168.1.5', cidr: '2001:db8::/32' },

  // --- the two deliberate divergences ---
  {
    address: '::ffff:192.168.1.5',
    cidr: '192.168.1.0/24',
    divergence:
      'the evaluator folds a mapped IPv4 address to the IPv4 host it routes to; the probe keeps it IPv6 and fails the family check',
  },
  {
    address: '::ffff:192.168.1.5',
    cidr: '::ffff:0:0/96',
    divergence:
      'having folded to IPv4, the evaluator no longer matches the IPv6 network that literally covers the mapped form; the probe does',
  },
];

function probeAllows(row: ContainmentRow): boolean {
  try {
    const address = canonicalAddress(row.address);
    return parseCidrs(row.cidr).some((cidr) => contains(cidr, address));
  } catch {
    // A rejected policy or a malformed address grants nothing.
    return false;
  }
}

async function evaluatorAllows(row: ContainmentRow): Promise<boolean> {
  // Never called: every row is an IP literal, so no resolution is involved.
  const lookup = vi.fn().mockRejectedValue(new Error('the contract table resolves nothing'));
  const adapter = new SystemLiveSourcePolicyEvaluatorAdapter({ lookup });
  const declared = isIP(row.cidr.split('/')[0]);
  const networks: RtspSourcePolicyNetwork[] = [
    {
      family: declared === 6 ? 6 : 4,
      cidr: row.cidr,
      interface: 'eth0',
    },
  ];
  const relationship = await adapter.evaluate([bracket(row.address)], { networks });
  expect(lookup).not.toHaveBeenCalled();
  return relationship === 'allowed';
}

/** `evaluate` takes a URL authority, so an IPv6 literal arrives bracketed. */
function bracket(address: string): string {
  return isIP(address) === 6 ? `[${address}]` : address;
}

describe('RTSP policy containment contract', () => {
  const agreeing = ROWS.filter((row) => row.divergence === undefined);
  const diverging = ROWS.filter((row) => row.divergence !== undefined);

  it.each(agreeing)(
    'agrees on $address against $cidr',
    async (row) => {
      expect(await evaluatorAllows(row)).toBe(probeAllows(row));
    },
  );

  it.each(diverging)(
    'diverges on $address against $cidr, deliberately',
    async (row) => {
      expect(await evaluatorAllows(row)).not.toBe(probeAllows(row));
    },
  );

  it('pins the divergence set at exactly the two documented rows', () => {
    expect(diverging.map((row) => `${row.address} in ${row.cidr}`)).toEqual([
      '::ffff:192.168.1.5 in 192.168.1.0/24',
      '::ffff:192.168.1.5 in ::ffff:0:0/96',
    ]);
  });

  it('leaves no row untested by either implementation', () => {
    expect(agreeing.length + diverging.length).toBe(ROWS.length);
    expect(agreeing.length).toBeGreaterThan(20);
  });
});
