import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function scenario(name: string): unknown {
  const output = execFileSync('python3', [
    resolve('test/scripts/live_stream_helper_harness.py'),
    resolve('scripts/live-stream-net-helper'),
    resolve('scripts/live-stream-policy-inspector'),
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
    expect(scenario('stale-recovery')).toEqual({ expiredPresent: false, livePresent: true, kernelTimeouts: true, routeQueries: 0 });
  });

  it('renders a UID-scoped allowlist followed by default deny', () => {
    const result = scenario('nft-policy') as { text: string };
    expect(result.text).not.toContain('oifname "lo" accept');
    expect(result.text).toContain('meta skuid 997 reject');
    expect(result.text).toContain('timeout 30s');
    expect(result.text.indexOf(' accept')).toBeLessThan(result.text.lastIndexOf(' reject'));
  });

  it('backs the UID catch-all with a group-keyed one, since the chain policy is accept', () => {
    const lines = (scenario('nft-policy') as { text: string }).text.split('\n');
    expect(lines).toContain('  meta skuid 997 reject');
    // The GID is threaded separately from the UID and outlives a recreated
    // stream account, so it catches traffic the stale UID reject would miss.
    expect(lines).toContain('  meta skgid 998 reject');
    const lastAccept = lines.reduce((last, line, index) => (line.endsWith(' accept') ? index : last), -1);
    const skuid = lines.indexOf('  meta skuid 997 reject');
    const skgid = lines.indexOf('  meta skgid 998 reject');
    expect(lastAccept).toBeGreaterThan(0);
    expect(skuid).toBeGreaterThan(lastAccept);
    // Both catch-alls last, and nothing after them: a rule appended below would
    // be unreachable, and one inserted above would shadow a reject.
    expect(skgid).toBe(skuid + 1);
    expect(lines.slice(skgid + 1).filter((line) => line.trim())).toEqual([' }', '}']);
    expect(lines.filter((line) => line.trimStart().startsWith('type filter hook output'))).toEqual([
      '  type filter hook output priority filter; policy accept;',
    ]);
  });

  it('rejects a policy that collapses worker and stream trust identities', () => {
    expect(scenario('same-uid-policy')).toEqual({ ok: false, reason: 'policy' });
  });

  it('refuses the superseded version 1 policy shape', () => {
    expect(scenario('version-one-policy')).toEqual({ ok: false, reason: 'policy' });
  });

  it('never rounds an nft timeout beyond lease expiry', () => {
    expect(scenario('subsecond-timeout')).toEqual({ subsecondAllowed: false, oneSecond: true });
  });

  it('allows egress only through an exact grant-derived address and port', () => {
    expect(scenario('exact-address-port')).toEqual({ exact: true, blanket: false });
  });

  it('uses collision-free set names for leases sharing the old prefix', () => {
    expect(scenario('set-name-collision')).toEqual({ first: true, second: true });
  });

  it('drops persisted access excluded by a narrowed policy', () => {
    expect(scenario('policy-narrowing')).toEqual({ leases: 0, staleRule: false });
  });

  it('drops a persisted lease whose interface left the policy', () => {
    expect(scenario('interface-narrowing')).toEqual({ leases: 0, staleRule: false });
  });

  it('drops the pre-upgrade lease shape while keeping its replay evidence', () => {
    expect(scenario('legacy-state')).toEqual({ leases: 0, staleRule: false, replayReason: 'replay' });
  });

  it('refuses a stale or missing root bundle inspector with one short code', () => {
    expect(scenario('stale-inspector')).toEqual({ stale: 'inspector', missing: 'inspector' });
  });

  it('refuses a policy network the inspector would never have discovered', () => {
    expect(scenario('loopback-policy')).toEqual({ ok: false, reason: 'policy' });
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

  it('accepts the configured IPv6 ULA prefix used by the worker policy', () => {
    expect(scenario('ipv6-ula-policy')).toEqual({ address: 'fd00::20' });
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

describe('live-stream net helper interface binding', () => {
  it('resolves the destination through the absolute allowlisted ip executable', () => {
    expect(scenario('constants')).toEqual({
      inspectorPath: '/usr/lib/home-worker/live-stream-policy-inspector',
      ipBinary: '/usr/sbin/ip',
      ipEnvironment: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/sbin:/usr/bin:/sbin:/bin' },
      routeTimeoutSeconds: 1,
    });
  });

  it('grants and binds oifname when the route leaves through the policy interface', () => {
    expect(scenario('route-match')).toEqual({
      ok: true,
      oifname: true,
      call: {
        argv: ['/usr/sbin/ip', '-4', '-j', 'route', 'get', '192.168.1.20'],
        env: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/sbin:/usr/bin:/sbin:/bin' },
        timeout: 1,
        check: false,
        stdin: true,
        stderr: true,
      },
    });
  });

  it('queries the matching address family for an IPv6 destination', () => {
    expect(scenario('route-family')).toEqual({
      argv: ['/usr/sbin/ip', '-6', '-j', 'route', 'get', 'fd00::20'],
      oifname: true,
    });
  });

  it.each([
    ['route-other-interface', 'interface'],
    ['route-vpn', 'interface'],
    ['route-bridge', 'interface'],
    ['route-gateway', 'interface'],
    ['route-malformed', 'route'],
    ['route-unavailable', 'route'],
  ])('refuses %s without rendering a rule', (name, reason) => {
    expect(scenario(name)).toMatchObject({ ok: false, reason, rendered: false });
  });

  it('keeps raw route output out of the stderr the worker can observe', () => {
    const result = scenario('route-malformed') as { stderr: string };
    expect(result.stderr).toBe('');
  });

  it('renders oifname with the destination address and port for both families', () => {
    expect(scenario('dual-family-render')).toEqual({
      v4Rule: true, v6Rule: true, v4Udp: true, v6Udp: true, v4Element: true, v6Element: true,
    });
  });

  it('binds each address of one lease to its own resolved interface', () => {
    expect(scenario('multi-interface-render')).toEqual({
      eth0Rule: true, wlan0Rule: true, eth0Element: true, wlan0Element: true,
    });
  });
});

describe('live-stream net helper runtime identity', () => {
  it('keys the group catch-all on the resolved group, never on the policy UID', () => {
    // build_engine is the one production path that resolves and threads the GID.
    expect(scenario('engine-group')).toEqual({ groupGid: true, policyUidAsGid: false, streamUid: true });
  });

  it('refuses to build an engine for a group that does not exist', () => {
    expect(scenario('missing-group')).toEqual({ ok: false, reason: 'group', subprocessCalls: 0 });
  });

  it('answers systemd only after the ruleset is applied and the socket accepts', () => {
    expect(scenario('serve-order')).toEqual({
      order: ['load_verified_policy', 'build_engine', 'listen', 'notify_ready', 'accept'],
    });
  });

  it('answers systemd once, and consumes the socket so no child can answer for it', () => {
    expect(scenario('notify-ready')).toEqual({ delivered: 'READY=1\n', consumed: true });
  });
});

describe('live-stream net helper policy and summary agreement', () => {
  it('accepts a private policy that matches the public summary', () => {
    const result = scenario('summary-match') as { digest: string; streamUid: number };
    expect(result.streamUid).toBe(997);
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('refuses a summary that disagrees on an identity change implying no route change', () => {
    expect(scenario('summary-uid-mismatch')).toEqual({ ok: false, reason: 'summary', subprocessCalls: 0 });
  });

  it('refuses a summary that disagrees on the UDP media range', () => {
    expect(scenario('summary-udp-mismatch')).toEqual({ ok: false, reason: 'summary' });
  });

  it('refuses to start without the public summary', () => {
    expect(scenario('summary-missing')).toEqual({ ok: false, reason: 'summary' });
  });

  it('refuses a private policy whose own digest does not cover its fields', () => {
    expect(scenario('corrupt-digest-policy')).toEqual({ ok: false, reason: 'policy' });
  });
});

it('never renders an interface-free accept rule', () => {
  const result = scenario('nft-policy') as { text: string };
  const accepts = result.text.split('\n').filter((line) => line.endsWith(' accept'));
  expect(accepts.length).toBeGreaterThan(0);
  expect(accepts.every((line) => line.includes('oifname "eth0"'))).toBe(true);
});
