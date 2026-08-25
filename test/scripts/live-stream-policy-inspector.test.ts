import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface Envelope {
  exitCode: number;
  stdout: { version?: number; networks?: unknown[]; ready?: boolean; reason?: string | null; digest?: string | null } | null;
  stdoutRaw: string;
  stderr: string;
  subprocessCalls?: number;
}

interface Fixture {
  links?: Record<string, unknown>[];
  routes?: Record<string, unknown>[];
  physicalDevices?: string[];
  summary?: Record<string, unknown>;
}

function invoke(mode: string, payload: unknown): Envelope {
  const output = execFileSync(
    'python3',
    [
      resolve('test/scripts/live_stream_policy_inspector_harness.py'),
      resolve('scripts/live-stream-policy-inspector'),
      mode,
    ],
    { input: JSON.stringify(payload), encoding: 'utf8' },
  );
  return JSON.parse(output) as Envelope;
}

function discover(fixture: Fixture): { version: number; networks: unknown[] } {
  const result = invoke('discover', fixture);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe('');
  return result.stdout as { version: number; networks: unknown[] };
}

function verify(fixture: Fixture): { ready: boolean; reason: string | null; digest: string | null; networks: unknown[] } {
  const result = invoke('verify', fixture);
  expect(result.exitCode).toBe(0);
  return result.stdout as { ready: boolean; reason: string | null; digest: string | null; networks: unknown[] };
}

function link(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ifname: 'eth0',
    operstate: 'UP',
    link_type: 'ether',
    flags: ['BROADCAST', 'MULTICAST', 'UP', 'LOWER_UP'],
    ...overrides,
  };
}

function route(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { dst: '192.168.1.0/24', dev: 'eth0', scope: 'link', protocol: 'kernel', ...overrides };
}

const ETH0 = { family: 4, cidr: '192.168.1.0/24', interface: 'eth0' };

describe('live-stream policy inspector discovery', () => {
  it('accepts a directly connected Ethernet subnet', () => {
    expect(discover({ links: [link()], routes: [route()], physicalDevices: ['eth0'] })).toEqual({
      version: 2,
      networks: [ETH0],
    });
  });

  it('accepts a directly connected Wi-Fi subnet', () => {
    const result = discover({
      links: [link({ ifname: 'wlan0' })],
      routes: [route({ dev: 'wlan0', dst: '10.20.30.0/24' })],
      physicalDevices: ['wlan0'],
    });
    expect(result.networks).toEqual([{ family: 4, cidr: '10.20.30.0/24', interface: 'wlan0' }]);
  });

  it('accepts an IPv6 unique-local prefix that reports no route scope', () => {
    const result = discover({
      links: [link()],
      routes: [{ dst: 'fd12:3456:789a::/64', dev: 'eth0', protocol: 'kernel', metric: 256, pref: 'medium' }],
      physicalDevices: ['eth0'],
    });
    expect(result.networks).toEqual([{ family: 6, cidr: 'fd12:3456:789a::/64', interface: 'eth0' }]);
  });

  it('accepts multiple direct private subnets on several physical interfaces', () => {
    const result = discover({
      links: [link(), link({ ifname: 'wlan0' })],
      routes: [
        route({ dst: '172.16.5.0/24' }),
        route({ dev: 'wlan0', dst: '192.168.8.0/22' }),
        route({ dst: '10.0.0.0/8' }),
      ],
      physicalDevices: ['eth0', 'wlan0'],
    });
    expect(result.networks).toEqual([
      { family: 4, cidr: '10.0.0.0/8', interface: 'eth0' },
      { family: 4, cidr: '172.16.5.0/24', interface: 'eth0' },
      { family: 4, cidr: '192.168.8.0/22', interface: 'wlan0' },
    ]);
  });

  it('sorts canonically by family, network, prefix length, then interface', () => {
    const result = discover({
      links: [link(), link({ ifname: 'wlan0' })],
      routes: [
        { dst: 'fd00::/64', dev: 'wlan0', protocol: 'kernel' },
        route({ dev: 'wlan0', dst: '192.168.1.0/24' }),
        { dst: 'fd00::/48', dev: 'eth0', protocol: 'kernel' },
        route({ dst: '192.168.1.0/24' }),
        route({ dst: '192.168.0.0/16' }),
      ],
      physicalDevices: ['eth0', 'wlan0'],
    });
    expect(result.networks).toEqual([
      { family: 4, cidr: '192.168.0.0/16', interface: 'eth0' },
      { family: 4, cidr: '192.168.1.0/24', interface: 'eth0' },
      { family: 4, cidr: '192.168.1.0/24', interface: 'wlan0' },
      { family: 6, cidr: 'fd00::/48', interface: 'eth0' },
      { family: 6, cidr: 'fd00::/64', interface: 'wlan0' },
    ]);
  });

  it('collapses duplicate interface and prefix pairs', () => {
    const result = discover({
      links: [link()],
      routes: [route(), route({ metric: 100 }), route({ prefsrc: '192.168.1.50' })],
      physicalDevices: ['eth0'],
    });
    expect(result.networks).toEqual([ETH0]);
  });

  it('requires a main-table unicast route with scope link', () => {
    expect(
      discover({
        links: [link()],
        routes: [
          route({ scope: 'global' }),
          route({ dst: '192.168.2.0/24', scope: 'host' }),
          { dst: '192.168.6.0/24', dev: 'eth0', protocol: 'kernel' },
          { dst: 'fd00::/64', dev: 'eth0', protocol: 'kernel', scope: 'host' },
          route({ dst: '192.168.3.0/24', table: 'local' }),
          route({ dst: '192.168.4.0/24', type: 'multicast' }),
          route({ dst: '192.168.5.0/24', type: 'blackhole' }),
        ],
        physicalDevices: ['eth0'],
      }).networks,
    ).toEqual([]);
  });

  it('rejects routed subnets that require a gateway', () => {
    expect(
      discover({
        links: [link()],
        routes: [route({ gateway: '192.168.1.1' }), route({ dst: '192.168.2.0/24', nexthops: [{ dev: 'eth0' }] })],
        physicalDevices: ['eth0'],
      }).networks,
    ).toEqual([]);
  });

  it('requires a concrete strict destination prefix', () => {
    expect(
      discover({
        links: [link()],
        routes: [
          route({ dst: 'default', gateway: undefined }),
          route({ dst: '::/0' }),
          route({ dst: '192.168.1.5/24' }),
          route({ dst: '192.168.1.5' }),
          route({ dst: '' }),
        ],
        physicalDevices: ['eth0'],
      }).networks,
    ).toEqual([]);
  });

  it('rejects public, loopback, link-local, multicast, and unspecified prefixes', () => {
    expect(
      discover({
        links: [link(), link({ ifname: 'lo', link_type: 'loopback', flags: ['LOOPBACK', 'UP', 'LOWER_UP'] })],
        routes: [
          route({ dst: '8.8.8.0/24' }),
          route({ dst: '2001:db8::/32' }),
          route({ dev: 'lo', dst: '127.0.0.0/8', scope: 'host' }),
          route({ dev: 'lo', dst: '127.0.0.0/8' }),
          route({ dst: '169.254.0.0/16' }),
          route({ dst: 'fe80::/64' }),
          route({ dst: '224.0.0.0/4' }),
          route({ dst: 'ff00::/8' }),
          route({ dst: '0.0.0.0/0' }),
          route({ dst: '::/0' }),
        ],
        physicalDevices: ['eth0', 'lo'],
      }).networks,
    ).toEqual([]);
  });

  it('rejects interfaces that are administratively down or without carrier', () => {
    expect(
      discover({
        links: [
          link({ ifname: 'eth0', operstate: 'DOWN', flags: ['BROADCAST', 'MULTICAST', 'UP'] }),
          link({ ifname: 'eth1', flags: ['BROADCAST', 'MULTICAST', 'LOWER_UP'] }),
          link({ ifname: 'eth2', operstate: 'UNKNOWN' }),
        ],
        routes: [route(), route({ dev: 'eth1', dst: '192.168.2.0/24' }), route({ dev: 'eth2', dst: '192.168.3.0/24' })],
        physicalDevices: ['eth0', 'eth1', 'eth2'],
      }).networks,
    ).toEqual([]);
  });

  it.each([
    ['bridge', link({ ifname: 'br0', linkinfo: { info_kind: 'bridge' } })],
    ['bond', link({ ifname: 'bond0', linkinfo: { info_kind: 'bond' } })],
    ['veth', link({ ifname: 'veth9a1b2c3', linkinfo: { info_kind: 'veth' } })],
    ['tun', link({ ifname: 'tun0', link_type: 'none', linkinfo: { info_kind: 'tun' } })],
    ['tap', link({ ifname: 'tap0', linkinfo: { info_kind: 'tun', info_data: { type: 'tap' } } })],
    ['wireguard', link({ ifname: 'wg0', link_type: 'none', linkinfo: { info_kind: 'wireguard' } })],
    ['docker', link({ ifname: 'docker0', linkinfo: { info_kind: 'bridge' } })],
    ['vlan', link({ ifname: 'eth0.10', linkinfo: { info_kind: 'vlan' } })],
  ])('rejects %s links even when they are up with carrier', (_kind, record) => {
    const name = record.ifname as string;
    expect(
      discover({
        links: [record],
        routes: [route({ dev: name, dst: '192.168.50.0/24' })],
        physicalDevices: [name],
      }).networks,
    ).toEqual([]);
  });

  it('rejects a virtual link that is absent from the device-backed set', () => {
    expect(
      discover({
        links: [link({ ifname: 'wg0', link_type: 'none' })],
        routes: [route({ dev: 'wg0', dst: '192.168.50.0/24' })],
        physicalDevices: [],
      }).networks,
    ).toEqual([]);
  });

  it('rejects a physical interface enslaved to a bridge or bond', () => {
    expect(
      discover({
        links: [link({ master: 'br0' })],
        routes: [route()],
        physicalDevices: ['eth0'],
      }).networks,
    ).toEqual([]);
  });

  it('rejects interface names that are not canonical kernel names of at most 15 bytes', () => {
    expect(
      discover({
        links: [
          link({ ifname: 'abcdefghijklmnop' }),
          link({ ifname: 'eth0 ' }),
          link({ ifname: 'veth0@if12' }),
          link({ ifname: '../../eth0' }),
        ],
        routes: [
          route({ dev: 'abcdefghijklmnop' }),
          route({ dev: 'eth0 ', dst: '192.168.2.0/24' }),
          route({ dev: 'veth0@if12', dst: '192.168.3.0/24' }),
          route({ dev: '../../eth0', dst: '192.168.4.0/24' }),
        ],
        physicalDevices: ['abcdefghijklmnop', 'eth0 ', 'veth0@if12', '../../eth0'],
      }).networks,
    ).toEqual([]);
  });

  it('requires the route device to match a link record exactly', () => {
    expect(
      discover({
        links: [link()],
        routes: [route({ dev: 'eth00' }), route({ dev: 'ETH0', dst: '192.168.2.0/24' })],
        physicalDevices: ['eth0', 'eth00', 'ETH0'],
      }).networks,
    ).toEqual([]);
  });

  it.each([
    ['route list', { links: [link()], routes: {}, physicalDevices: ['eth0'] }],
    ['route record', { links: [link()], routes: ['192.168.1.0/24'], physicalDevices: ['eth0'] }],
    ['route destination', { links: [link()], routes: [route({ dst: 12 })], physicalDevices: ['eth0'] }],
    ['route device', { links: [link()], routes: [route({ dev: ['eth0'] })], physicalDevices: ['eth0'] }],
    ['link record', { links: ['eth0'], routes: [route()], physicalDevices: ['eth0'] }],
    ['link name', { links: [link({ ifname: 7 })], routes: [route()], physicalDevices: ['eth0'] }],
    ['link flags', { links: [link({ flags: 'UP' })], routes: [route()], physicalDevices: ['eth0'] }],
    ['duplicate link', { links: [link(), link()], routes: [route()], physicalDevices: ['eth0'] }],
  ])('fails closed on a malformed %s', (_case, fixture) => {
    const result = invoke('discover', fixture);
    expect(result.exitCode).toBe(1);
    expect(result.stdoutRaw).toBe('');
    expect(result.stderr.trim()).toBe('network-state-unavailable');
    expect(result.stderr).not.toContain('192.168');
    expect(result.stderr).not.toContain('eth0');
  });

  it.each([[[]], [['discover', 'extra']], [['verify']], [['--help']], [['reboot']]])(
    'exits 2 for %j without invoking a subprocess',
    (argv) => {
      const result = invoke('command', { argv });
      expect(result.exitCode).toBe(2);
      expect(result.subprocessCalls).toBe(0);
      expect(result.stdoutRaw).toBe('');
    },
  );
});

interface IpEnvelope {
  links?: unknown[];
  routes?: unknown[];
  journalLabels?: string[];
  unavailable?: string;
  calls: { argv: string[]; env: Record<string, string>; timeout: number; check: boolean; stdin: boolean; stderr: boolean }[];
}

function invokeIp(responses: Record<string, unknown>[]): IpEnvelope {
  return invoke('ip', { responses }) as unknown as IpEnvelope;
}

const LINK_ARGV = ['/usr/sbin/ip', '-d', '-j', 'link', 'show'];
const ROUTE4_ARGV = ['/usr/sbin/ip', '-j', '-4', 'route', 'show', 'table', 'main'];
const ROUTE6_ARGV = ['/usr/sbin/ip', '-j', '-6', 'route', 'show', 'table', 'main'];

describe('live-stream policy inspector production invocation', () => {
  it('pins the fixed root paths, identities, and closed command set', () => {
    const constants = invoke('constants', {}) as unknown as Record<string, unknown>;
    expect(constants).toEqual({
      ipBinary: '/usr/sbin/ip',
      ipEnvironment: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/sbin:/usr/bin:/sbin:/bin' },
      ipTimeoutSeconds: 5,
      summaryPath: '/etc/home-worker/live-stream-policy.summary.json',
      sysClassNet: '/sys/class/net',
      summaryOwnerUid: 0,
      summaryMode: 0o644,
      policyVersion: 2,
      maxOutputBytes: 64 * 1024,
      commands: ['discover', 'verify-installed'],
    });
  });

  it('reads link and both route families through the fixed allowlisted executable', () => {
    const result = invokeIp([
      { stdout: JSON.stringify([link()]) },
      { stdout: JSON.stringify([route()]) },
      { stdout: '[]' },
    ]);
    expect(result.calls.map((call) => call.argv)).toEqual([LINK_ARGV, ROUTE4_ARGV, ROUTE6_ARGV]);
    for (const call of result.calls) {
      expect(call.env).toEqual({ LANG: 'C', LC_ALL: 'C', PATH: '/usr/sbin:/usr/bin:/sbin:/bin' });
      expect(call.timeout).toBe(5);
      expect(call.check).toBe(false);
      expect(call.stdin).toBe(true);
      expect(call.stderr).toBe(true);
    }
    expect(result.links).toEqual([link()]);
    expect(result.routes).toEqual([route()]);
  });

  it('treats a refused IPv6 dump as an empty route set', () => {
    const result = invokeIp([
      { stdout: '[]' },
      { stdout: JSON.stringify([route()]) },
      { returncode: 2, stdout: '' },
    ]);
    expect(result.unavailable).toBeUndefined();
    expect(result.routes).toEqual([route()]);
    expect(result.journalLabels).toEqual(['link', 'route4']);
  });

  it('still discovers an IPv4 subnet when the kernel has IPv6 disabled', () => {
    const result = invoke('ip', {
      responses: [
        { stdout: JSON.stringify([link()]) },
        { stdout: JSON.stringify([route()]) },
        { returncode: 2, stdout: 'Error: ipv6: Address family not supported by protocol.' },
      ],
    }) as unknown as IpEnvelope;
    expect(result.unavailable).toBeUndefined();
    expect(result.links).toEqual([link()]);
    expect(result.routes).toEqual([route()]);
  });

  it('still fails closed when a dump the kernel answered does not parse', () => {
    const result = invokeIp([{ stdout: '[]' }, { stdout: '[]' }, { stdout: '{' }]);
    expect(result.unavailable).toBe('route6');
  });

  it('fails closed when the link or IPv4 route dump exits non-zero', () => {
    expect(invokeIp([{ returncode: 1, stdout: '' }]).unavailable).toBe('ip');
    const routes = invokeIp([{ stdout: '[]' }, { returncode: 1, stdout: '' }]);
    expect(routes.unavailable).toBe('ip');
    expect(routes.calls.map((call) => call.argv)).toEqual([LINK_ARGV, ROUTE4_ARGV]);
  });

  it('rejects output beyond the 64 KiB cap', () => {
    expect(invokeIp([{ size: 64 * 1024 + 1 }]).unavailable).toBe('ip');
    expect(invokeIp([{ size: 64 * 1024 }, { stdout: '[]' }, { stdout: '[]' }]).unavailable).toBeUndefined();
  });
});

describe('live-stream policy inspector device backing', () => {
  it('accepts only device-backed Ethernet class entries under the fixed sysfs root', () => {
    const result = invoke('physical-devices', {
      entries: [
        { name: 'eth0', device: true, type: 1 },
        { name: 'wlan0', device: true, type: 1 },
        { name: 'br0', device: false, type: 1 },
        { name: 'wg0', device: false, type: 65534 },
        { name: 'lo', device: false, type: 772 },
        { name: 'can0', device: true, type: 280 },
        { name: 'abcdefghijklmnop', device: true, type: 1 },
      ],
    }) as unknown as { devices: string[] };
    expect(result.devices).toEqual(['eth0', 'wlan0']);
  });
});

describe('live-stream policy inspector installed verification', () => {
  const fixture: Fixture = { links: [link()], routes: [route()], physicalDevices: ['eth0'] };

  it('reports the installed digest and redacted networks when the policy still matches', () => {
    const result = verify(fixture);
    expect(result.ready).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.networks).toEqual([ETH0]);
  });

  it('emits no policy secrets beyond ready, reason, digest, and networks', () => {
    const result = invoke('verify', fixture);
    expect(Object.keys(result.stdout as object).sort()).toEqual(['digest', 'networks', 'ready', 'reason', 'version']);
    expect(result.stdoutRaw).not.toContain('workerUid');
    expect(result.stdoutRaw).not.toContain('udpPort');
  });

  it('reports policy-stale when the installed networks no longer match the current ones', () => {
    const result = verify({
      ...fixture,
      summary: { networks: [{ family: 4, cidr: '192.168.9.0/24', interface: 'eth0' }] },
    });
    expect(result.ready).toBe(false);
    expect(result.reason).toBe('policy-stale');
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.networks).toEqual([ETH0]);
  });

  it('reports policy-stale when the same subnet moved to another interface', () => {
    const result = verify({
      ...fixture,
      summary: { networks: [{ family: 4, cidr: '192.168.1.0/24', interface: 'wlan0' }] },
    });
    expect(result.reason).toBe('policy-stale');
    expect(result.networks).toEqual([ETH0]);
  });

  it('reports local-network-unavailable when no eligible network remains', () => {
    const result = verify({
      links: [link({ operstate: 'DOWN', flags: ['BROADCAST', 'MULTICAST'] })],
      routes: [route()],
      physicalDevices: ['eth0'],
      summary: { networks: [ETH0] },
    });
    expect(result).toEqual({ version: 2, ready: false, reason: 'local-network-unavailable', digest: null, networks: [] });
  });

  it.each([
    ['a missing summary', { missing: true }],
    ['a symlinked summary', { symlink: true }],
    ['a group-writable summary', { mode: 0o664 }],
    ['a world-writable summary', { mode: 0o666 }],
    ['a private summary', { mode: 0o600 }],
    ['a multiply linked summary', { hardlink: true }],
    ['a summary owned by another user', { ownerMismatch: true }],
    ['malformed summary JSON', { raw: '{"version":2,' }],
    ['a duplicated summary key', { raw: '{"version":2,"version":2}' }],
    ['an unknown summary field', { overrides: { extra: true } }],
    ['a missing summary field', { omit: ['digest'] }],
    ['a mismatched digest', { overrides: { digest: 'a'.repeat(64) } }],
    ['a malformed digest', { overrides: { digest: 'NOTHEX' } }],
    ['an unsupported schema version', { version: 1 }],
    ['an empty network list', { networks: [] }],
    ['a non-canonical network order', {
      networks: [
        { family: 4, cidr: '192.168.2.0/24', interface: 'eth0' },
        { family: 4, cidr: '192.168.1.0/24', interface: 'eth0' },
      ],
    }],
    ['a duplicated network pair', { networks: [ETH0, ETH0] }],
    ['a mismatched address family', { networks: [{ family: 6, cidr: '192.168.1.0/24', interface: 'eth0' }] }],
    ['a public installed network', { networks: [{ family: 4, cidr: '8.8.8.0/24', interface: 'eth0' }] }],
    ['a non-canonical installed prefix', { networks: [{ family: 4, cidr: '192.168.1.5/24', interface: 'eth0' }] }],
    ['an invalid installed interface', { networks: [{ family: 4, cidr: '192.168.1.0/24', interface: 'abcdefghijklmnop' }] }],
    ['colliding worker and stream identities', { workerUid: 1001, streamUid: 1001 }],
    ['a negative worker identity', { workerUid: -1 }],
    ['a privileged UDP port', { udpPortFirst: 80, udpPortLast: 24001 }],
    ['an inverted UDP range', { udpPortFirst: 24001, udpPortLast: 24000 }],
    ['an out-of-range UDP port', { udpPortFirst: 24000, udpPortLast: 70000 }],
  ])('reports policy-summary-invalid for %s', (_case, summary) => {
    const result = verify({ ...fixture, summary });
    expect(result).toEqual({ version: 2, ready: false, reason: 'policy-summary-invalid', digest: null, networks: [] });
  });
});
