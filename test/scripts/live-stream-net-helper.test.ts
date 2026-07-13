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
    expect(result.text).toContain('meta skuid 997 oifname "lo" accept');
    expect(result.text).toContain('meta skuid 997 reject');
    expect(result.text).toContain('timeout 30s');
    expect(result.text.indexOf(' accept')).toBeLessThan(result.text.lastIndexOf(' reject'));
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
