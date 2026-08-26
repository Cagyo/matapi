import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RtspPolicyDigestMismatchError } from '../../../src/features/domain/errors/rtsp-policy-digest-mismatch.error';
import { RtspPolicyUnavailableError } from '../../../src/features/domain/errors/rtsp-policy-unavailable.error';
import { InstalledRtspPolicyStatusAdapter } from '../../../src/features/infrastructure/installed-rtsp-policy-status.adapter';
import {
  RTSP_POLICY_INSPECTOR,
  RtspPolicyInspectorGateway,
} from '../../../src/features/infrastructure/readiness/rtsp-policy-inspector.gateway';
import { nodeReadinessFiles } from '../../../src/features/infrastructure/readiness/readiness-seams';

const SUMMARY_PATH = '/etc/home-worker/live-stream-policy.summary.json';
const NETWORKS = [{ family: 4 as const, cidr: '192.168.1.0/24', interface: 'eth0' }];

/** The installer's canonical encoding, spelled out so a silent drift fails here. */
function digestOf(document: Record<string, unknown>): string {
  const networks = (document.networks as readonly { family: number; cidr: string; interface: string }[])
    .map((entry) => `{"cidr":${JSON.stringify(entry.cidr)},"family":${entry.family},"interface":${JSON.stringify(entry.interface)}}`)
    .join(',');
  const payload = `{"networks":[${networks}],"streamUid":${String(document.streamUid)}`
    + `,"udpPortFirst":${String(document.udpPortFirst)},"udpPortLast":${String(document.udpPortLast)}`
    + `,"version":${String(document.version)},"workerUid":${String(document.workerUid)}}`;
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

function summaryDocument(overrides: Record<string, unknown> = {}) {
  const document = {
    version: 2,
    workerUid: 1001,
    streamUid: 1002,
    networks: NETWORKS,
    udpPortFirst: 24_000,
    udpPortLast: 24_001,
    ...overrides,
  };
  return { ...document, digest: digestOf(document) };
}

function sealed(content: string, overrides: Record<string, unknown> = {}) {
  return {
    uid: 0,
    gid: 0,
    mode: 0o644,
    size: Buffer.byteLength(content),
    nlink: 1,
    isFile: true,
    content,
    ...overrides,
  };
}

function verdict(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: 2,
    ready: true,
    reason: null,
    digest: summaryDocument().digest,
    networks: NETWORKS,
    ...overrides,
  });
}

interface Options { document?: Record<string, unknown>; file?: Record<string, unknown>; env?: Record<string, string | undefined>; stdout?: string; fail?: Error }

function build(options: Options = {}) {
  const document = options.document ?? summaryDocument();
  const body = JSON.stringify(document) + '\n';
  const readSealed = vi.fn(async () => sealed(body, options.file));
  const execFile = vi.fn(async () => {
    if (options.fail) throw options.fail;
    return { stdout: options.stdout ?? verdict({ digest: document.digest }), stderr: '' };
  });
  const adapter = new InstalledRtspPolicyStatusAdapter({
    inspector: new RtspPolicyInspectorGateway({ execFile }),
    files: { readSealed },
    env: options.env ?? { RTSP_ALLOWED_CIDRS: '192.168.1.0/24', RTSP_POLICY_DIGEST: String(document.digest) },
  });
  return { adapter, readSealed, execFile };
}

describe('installed RTSP policy status', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports the verified projection and invokes only the fixed inspector command', async () => {
    const { adapter, readSealed, execFile } = build();

    await expect(adapter.inspect()).resolves.toEqual({
      state: 'ready',
      digest: summaryDocument().digest,
      networks: NETWORKS,
    });
    expect(readSealed).toHaveBeenCalledWith(SUMMARY_PATH, 64 * 1024);
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledWith(
      RTSP_POLICY_INSPECTOR,
      ['verify-installed'],
      expect.objectContaining({ maxBuffer: 64 * 1024, timeout: 5_000 }),
    );
    expect(RTSP_POLICY_INSPECTOR).toBe('/usr/lib/home-worker/live-stream-policy-inspector');
  });

  it('accepts a summary digested by the root installer itself', async () => {
    // The worker's digest and the installer's are only comparable while both
    // encodings agree byte for byte, and nothing else would notice if they
    // stopped: every other check compares one side with itself.
    const script = 'import importlib.machinery, importlib.util, sys\n'
      + 'loader = importlib.machinery.SourceFileLoader("inspector", "scripts/live-stream-policy-inspector")\n'
      + 'module = importlib.util.module_from_spec(importlib.util.spec_from_loader("inspector", loader))\n'
      + 'loader.exec_module(module)\n'
      + 'networks = [module.EligibleNetwork(4, "192.168.1.0/24", "eth0"), module.EligibleNetwork(6, "fd00::/64", "wlan0")]\n'
      + 'sys.stdout.write(module.policy_digest(2, 1001, 1002, networks, 24000, 24001))\n';
    const digest = execFileSync('python3', ['-c', script], { encoding: 'utf8' });
    const networks = [
      { family: 4 as const, cidr: '192.168.1.0/24', interface: 'eth0' },
      { family: 6 as const, cidr: 'fd00::/64', interface: 'wlan0' },
    ];
    const document = {
      version: 2, workerUid: 1001, streamUid: 1002, networks,
      udpPortFirst: 24_000, udpPortLast: 24_001, digest,
    };
    const { adapter } = build({
      document,
      stdout: verdict({ digest, networks }),
      env: { RTSP_ALLOWED_CIDRS: '192.168.1.0/24,fd00::/64', RTSP_POLICY_DIGEST: digest },
    });

    await expect(adapter.inspect()).resolves.toEqual({ state: 'ready', digest, networks });
  });

  it('canonicalizes the worker-visible CIDR list instead of comparing raw text', async () => {
    const document = summaryDocument({
      networks: [
        { family: 4 as const, cidr: '192.168.1.0/24', interface: 'eth0' },
        { family: 6 as const, cidr: 'fd00::/64', interface: 'wlan0' },
      ],
    });
    const { adapter } = build({
      document,
      stdout: verdict({ digest: document.digest, networks: document.networks }),
      env: {
        RTSP_ALLOWED_CIDRS: ' 192.168.1.0/24 , FD00:0000:0000:0000::/64 ',
        RTSP_POLICY_DIGEST: document.digest,
      },
    });

    await expect(adapter.inspect()).resolves.toMatchObject({ state: 'ready' });
  });

  it('accepts one environment entry for a CIDR reached through two interfaces', async () => {
    const networks = [
      { family: 4 as const, cidr: '192.168.1.0/24', interface: 'eth0' },
      { family: 4 as const, cidr: '192.168.1.0/24', interface: 'wlan0' },
    ];
    const document = summaryDocument({ networks });
    const { adapter } = build({
      document,
      stdout: verdict({ digest: document.digest, networks }),
      env: { RTSP_ALLOWED_CIDRS: '192.168.1.0/24', RTSP_POLICY_DIGEST: document.digest },
    });

    await expect(adapter.inspect()).resolves.toMatchObject({ state: 'ready' });
  });

  it('reports a stale policy when the inspector rediscovers a different network', async () => {
    const current = [{ family: 4 as const, cidr: '10.9.0.0/24', interface: 'eth0' }];
    const { adapter } = build({
      stdout: verdict({ ready: false, reason: 'policy-stale', networks: current }),
    });

    await expect(adapter.inspect()).resolves.toEqual({
      state: 'stale',
      digest: summaryDocument().digest,
      networks: current,
    });
  });

  it.each([
    ['local-network-unavailable'],
    ['policy-summary-invalid'],
  ])('reports %s as unavailable without a digest', async (reason) => {
    const { adapter } = build({
      stdout: verdict({ ready: false, reason, digest: null, networks: [] }),
    });

    await expect(adapter.inspect()).resolves.toEqual({ state: 'unavailable', digest: null, networks: [] });
  });

  it.each([
    ['a mode other than 0644', { mode: 0o664 }],
    ['a non-root owner', { uid: 1000 }],
    ['more than one link', { nlink: 2 }],
    ['a directory or device', { isFile: false }],
    ['a body beyond the 64 KiB cap', { size: 64 * 1024 + 1 }],
  ])('refuses a public summary with %s before running the helper', async (_label, file) => {
    const { adapter, execFile } = build({ file });

    await expect(adapter.inspect()).resolves.toEqual({ state: 'unavailable', digest: null, networks: [] });
    expect(execFile).not.toHaveBeenCalled();
  });

  it.each([
    ['version', { version: 3 }],
    ['workerUid', { workerUid: 1010 }],
    ['streamUid', { streamUid: 1020 }],
    ['networks', { networks: [{ family: 4 as const, cidr: '192.168.2.0/24', interface: 'eth0' }] }],
    ['the bound interface', { networks: [{ family: 4 as const, cidr: '192.168.1.0/24', interface: 'wlan0' }] }],
    ['udpPortFirst', { udpPortFirst: 24_002 }],
    ['udpPortLast', { udpPortLast: 24_009 }],
  ])('rejects a summary whose stored digest no longer covers %s', async (_label, overrides) => {
    const stored = summaryDocument();
    const document = { ...stored, ...overrides }; // digest kept from the unmodified document

    const { adapter, execFile } = build({
      document,
      env: { RTSP_ALLOWED_CIDRS: '192.168.1.0/24', RTSP_POLICY_DIGEST: stored.digest },
    });

    await expect(adapter.inspect()).resolves.toEqual({ state: 'unavailable', digest: null, networks: [] });
    expect(execFile).not.toHaveBeenCalled();
  });

  it.each([
    ['an unparsable body', 'not json'],
    ['an unknown key', JSON.stringify({ ...summaryDocument(), extra: 1 })],
    ['a public network', JSON.stringify(summaryDocument({ networks: [{ family: 4, cidr: '8.8.8.0/24', interface: 'eth0' }] }))],
    ['a non-canonical prefix', JSON.stringify(summaryDocument({ networks: [{ family: 4, cidr: '192.168.1.1/24', interface: 'eth0' }] }))],
    ['a broad prefix', JSON.stringify(summaryDocument({ networks: [{ family: 4, cidr: '0.0.0.0/0', interface: 'eth0' }] }))],
    ['no network at all', JSON.stringify(summaryDocument({ networks: [] }))],
    ['a mismatched family', JSON.stringify(summaryDocument({ networks: [{ family: 6, cidr: '192.168.1.0/24', interface: 'eth0' }] }))],
    ['an unsorted network list', JSON.stringify(summaryDocument({
      networks: [
        { family: 4, cidr: '192.168.2.0/24', interface: 'eth0' },
        { family: 4, cidr: '192.168.1.0/24', interface: 'eth0' },
      ],
    }))],
  ])('rejects a summary with %s', async (_label, body) => {
    const readSealed = vi.fn(async () => sealed(body));
    const execFile = vi.fn(async () => ({ stdout: verdict(), stderr: '' }));
    const adapter = new InstalledRtspPolicyStatusAdapter({
      inspector: new RtspPolicyInspectorGateway({ execFile }),
      files: { readSealed },
      env: { RTSP_ALLOWED_CIDRS: '192.168.1.0/24', RTSP_POLICY_DIGEST: summaryDocument().digest },
    });

    await expect(adapter.inspect()).resolves.toEqual({ state: 'unavailable', digest: null, networks: [] });
    expect(execFile).not.toHaveBeenCalled();
  });

  it.each([
    ['a stale CIDR list', { RTSP_ALLOWED_CIDRS: '10.0.0.0/8' }],
    ['an absent CIDR list', { RTSP_ALLOWED_CIDRS: undefined }],
    ['a malformed CIDR list', { RTSP_ALLOWED_CIDRS: '192.168.001.0/24' }],
    ['an extra CIDR', { RTSP_ALLOWED_CIDRS: '192.168.1.0/24,10.0.0.0/8' }],
    ['a stale digest', { RTSP_POLICY_DIGEST: 'f'.repeat(64) }],
    ['an absent digest', { RTSP_POLICY_DIGEST: undefined }],
    ['a shifted UDP range', { RTSP_UDP_PORT_FIRST: '24010', RTSP_UDP_PORT_LAST: '24011' }],
    ['a malformed UDP range', { RTSP_UDP_PORT_FIRST: '24000x' }],
  ])('refuses the projection when the process environment disagrees through %s', async (_label, overrides) => {
    const { adapter, execFile } = build({
      env: {
        RTSP_ALLOWED_CIDRS: '192.168.1.0/24',
        RTSP_POLICY_DIGEST: summaryDocument().digest,
        ...overrides,
      },
    });

    await expect(adapter.inspect()).resolves.toEqual({ state: 'unavailable', digest: null, networks: [] });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('accepts an environment that leaves the default UDP range implicit', async () => {
    const { adapter } = build({
      env: { RTSP_ALLOWED_CIDRS: '192.168.1.0/24', RTSP_POLICY_DIGEST: summaryDocument().digest, RTSP_UDP_PORT_FIRST: '' },
    });

    await expect(adapter.inspect()).resolves.toMatchObject({ state: 'ready' });
  });

  it.each([
    ['a verdict for a different digest', verdict({ digest: 'a'.repeat(64) })],
    ['a ready verdict for other networks', verdict({ networks: [{ family: 4, cidr: '10.0.0.0/8', interface: 'eth0' }] })],
    ['an unknown reason', verdict({ ready: false, reason: 'something-else', digest: null, networks: [] })],
    ['a ready verdict carrying a reason', verdict({ reason: 'policy-stale' })],
    ['another protocol version', verdict({ version: 3 })],
    ['an unparsable answer', 'not json'],
    ['an oversized answer', 'x'.repeat(64 * 1024 + 1)],
  ])('refuses %s from the helper', async (_label, stdout) => {
    const { adapter } = build({ stdout });

    await expect(adapter.inspect()).resolves.toEqual({ state: 'unavailable', digest: null, networks: [] });
  });

  it('treats a failing helper invocation as unavailable and never repeats its output', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const secret = 'workerUid=1001 policy=/etc/home-worker/live-stream-policy.json';
    const { adapter } = build({ fail: Object.assign(new Error(secret), { stdout: secret, stderr: secret }) });

    await expect(adapter.inspect()).resolves.toEqual({ state: 'unavailable', digest: null, networks: [] });
    for (const call of warn.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('workerUid');
      expect(JSON.stringify(call)).not.toContain('live-stream-policy.json');
    }
  });

  it('requires a current policy and fences the digest afterwards', async () => {
    const { adapter } = build();

    expect(() => adapter.assertDigest(summaryDocument().digest)).toThrow(RtspPolicyDigestMismatchError);
    await expect(adapter.requireCurrent()).resolves.toEqual({
      digest: summaryDocument().digest,
      networks: NETWORKS,
    });
    expect(() => adapter.assertDigest(summaryDocument().digest)).not.toThrow();
    expect(() => adapter.assertDigest('b'.repeat(64))).toThrow(RtspPolicyDigestMismatchError);
  });

  it('drops the fence and refuses requireCurrent once the policy goes stale', async () => {
    const stale = verdict({ ready: false, reason: 'policy-stale', networks: [{ family: 4, cidr: '10.9.0.0/24', interface: 'eth0' }] });
    const execFile = vi.fn()
      .mockResolvedValueOnce({ stdout: verdict(), stderr: '' })
      .mockResolvedValue({ stdout: stale, stderr: '' });
    const body = JSON.stringify(summaryDocument()) + '\n';
    const adapter = new InstalledRtspPolicyStatusAdapter({
      inspector: new RtspPolicyInspectorGateway({ execFile }),
      files: { readSealed: vi.fn(async () => sealed(body)) },
      env: { RTSP_ALLOWED_CIDRS: '192.168.1.0/24', RTSP_POLICY_DIGEST: summaryDocument().digest },
    });

    await adapter.requireCurrent();
    await expect(adapter.requireCurrent()).rejects.toBeInstanceOf(RtspPolicyUnavailableError);
    expect(() => adapter.assertDigest(summaryDocument().digest)).toThrow(RtspPolicyDigestMismatchError);
  });
});

describe('sealed summary reads', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'rtsp-policy-'));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('refuses to follow a symlink into another file', async () => {
    const target = join(directory, 'target.json');
    const link = join(directory, 'summary.json');
    writeFileSync(target, '{}', { mode: 0o644 });
    symlinkSync(target, link);

    await expect(nodeReadinessFiles.readSealed(link, 64 * 1024)).rejects.toThrow();
  });

  it('reports the descriptor it read, and never more than the cap', async () => {
    const path = join(directory, 'summary.json');
    writeFileSync(path, 'x'.repeat(100), { mode: 0o644 });

    const file = await nodeReadinessFiles.readSealed(path, 16);
    expect(file.isFile).toBe(true);
    expect(file.nlink).toBe(1);
    expect(file.mode).toBe(0o644);
    expect(file.size).toBe(100);
    expect(file.content.length).toBeLessThanOrEqual(17);
  });
});
