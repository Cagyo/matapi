import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function scenario(name: string): unknown {
  const output = execFileSync('python3', [
    resolve('test/scripts/live_stream_helper_harness.py'),
    resolve('scripts/live-stream-net-helper'),
    name,
  ], { encoding: 'utf8' });
  return JSON.parse(output);
}

describe('live-stream net helper security behavior', () => {
  it.each([
    ['unknown-key', 'unknown-field'],
    ['hostname', 'address'],
    ['public-address', 'address'],
    ['out-of-cidr', 'address'],
    ['expired', 'expiry'],
    ['udp-bounds', 'udp-range'],
    ['injection', 'session'],
  ])('rejects %s input', (name, reason) => {
    expect(scenario(name)).toEqual({ ok: false, reason });
  });

  it('rejects replay across helper restart while runtime state persists', () => {
    expect(scenario('replay-restart')).toEqual({ ok: false, reason: 'replay', preservedLease: true });
  });

  it('revokes only a matching session and opaque lease pair', () => {
    expect(scenario('exact-revoke')).toEqual({ wrongPairRejected: true, firstPresent: false, secondPresent: true });
  });

  it('removes expired leases but preserves live leases during crash recovery', () => {
    expect(scenario('stale-recovery')).toEqual({ expiredPresent: false, livePresent: true, kernelTimeouts: true });
  });

  it('renders a UID-scoped allowlist followed by default deny', () => {
    const result = scenario('nft-policy') as { text: string };
    expect(result.text).not.toContain('oifname "lo" accept');
    expect(result.text).toContain('meta skuid 997 reject');
    expect(result.text).toContain('timeout 30s');
    expect(result.text.indexOf(' accept')).toBeLessThan(result.text.lastIndexOf(' reject'));
  });

  it('rejects a policy that collapses worker and stream trust identities', () => {
    expect(scenario('same-uid-policy')).toEqual({ ok: false, reason: 'policy' });
  });

  it('never rounds an nft timeout beyond lease expiry', () => {
    expect(scenario('subsecond-timeout')).toEqual({ subsecondAllowed: false, oneSecond: true });
  });

  it('allows loopback only through an exact grant-derived address and port', () => {
    expect(scenario('loopback-exact')).toEqual({ exact: true, blanket: false });
  });

  it('uses collision-free set names for leases sharing the old prefix', () => {
    expect(scenario('set-name-collision')).toEqual({ first: true, second: true });
  });

  it('drops persisted access excluded by a narrowed policy', () => {
    expect(scenario('policy-narrowing')).toEqual({ leases: 0, staleRule: false });
  });

  it('refuses startup when malformed live nonce state destroys replay evidence', () => {
    expect(scenario('corrupt-recovery')).toEqual({ ok: false, reason: 'state', nftApplied: false });
  });

  it('discards malformed persisted leases without crashes or stale rules', () => {
    expect(scenario('corrupt-lease-recovery')).toEqual({ leases: ['77777777777777777777777777777777'], corruptRule: false });
  });

  it('never resurrects an expired lease when a later grant rebuilds nft state', () => {
    expect(scenario('expired-next-grant')).toEqual({ expiredRendered: false, newRendered: true });
  });

  it('accepts the configured IPv6 ULA /8 used by the worker policy', () => {
    expect(scenario('ipv6-ula-policy')).toEqual({ address: 'fd12::20' });
  });

  it('rejects a trickling authenticated request at one absolute read deadline', () => {
    expect(scenario('slow-client')).toEqual({ ok: false, reason: 'request' });
  });

  it('contains a disconnected client write failure instead of crashing the daemon', () => {
    expect(scenario('broken-write')).toEqual({ sent: false });
  });

  it('rejects duplicate JSON keys instead of accepting the last value', () => {
    expect(scenario('duplicate-key')).toEqual({ ok: false, reason: 'request' });
  });
});
