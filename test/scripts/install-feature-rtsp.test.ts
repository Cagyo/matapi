import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const installFeature = readFileSync(resolve('scripts/install-feature.sh'), 'utf8');

/** The program body a marker line introduces, whatever follows the redirection. */
const heredoc = (marker: string): string => {
  const start = installFeature.indexOf(marker);
  if (start < 0) throw new Error(`RTSP program not found: ${marker}`);
  const body = installFeature.indexOf('\n', start + marker.length) + 1;
  return installFeature.slice(body, installFeature.indexOf('\nPY', body));
};

const GATE_MARKER = 'sudo python3 - "$SCRIPT_DIR/live-stream-policy-inspector" <<\'PY\'';
const STAGE_MARKER =
  'env_identity="$(sudo python3 - "$inspector" "$env_file" "$policy_file" "$summary_file" "$root_uid" "$root_gid" "$(id -u "$USER")" "$(id -u "$stream_user")" <<\'PY\'';
const COMMIT_MARKER =
  'sudo python3 - "$inspector" "$policy_file" "$summary_file" "$env_file" /etc/systemd/system/homeworker-stream-net.service "$root_uid" "$root_gid" "$(id -u "$USER")" "$env_identity" <<\'PY\'';

const PYTHON = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
const OWNER_UID = process.getuid?.() ?? 0;
const OWNER_GID = process.getgid?.() ?? 0;
const STREAM_UID = OWNER_UID + 1;
const REAL_INSPECTOR = resolve('scripts/live-stream-policy-inspector');
const ETH0 = { family: 4, cidr: '192.168.1.0/24', interface: 'eth0' };
const CANONICAL_KEYS = [
  'cidr', 'digest', 'family', 'interface', 'networks',
  'streamUid', 'udpPortFirst', 'udpPortLast', 'version', 'workerUid',
];
const CREDENTIAL_KEY = 'ab'.repeat(32);

interface Network { family: number; cidr: string; interface: string }

/**
 * The fixture inspector is the real root inspector with only its kernel-state
 * reader and its two fixed paths redirected, so every canonical rule and the
 * digest under test are the production ones.
 */
const inspectorSource = (configPath: string) => [
  `#!${PYTHON}`,
  'import importlib.machinery, importlib.util, json, sys',
  'from pathlib import Path',
  `CONFIG = json.loads(Path(${JSON.stringify(configPath)}).read_text())`,
  `_loader = importlib.machinery.SourceFileLoader("real_inspector", ${JSON.stringify(REAL_INSPECTOR)})`,
  '_module = importlib.util.module_from_spec(importlib.util.spec_from_loader(_loader.name, _loader))',
  '_loader.exec_module(_module)',
  '_module.current_networks = lambda: [_module.EligibleNetwork(**entry) for entry in CONFIG["networks"]]',
  '_module.SUMMARY_PATH = CONFIG["summaryPath"]',
  '_module.EXPECTED_SUMMARY_OWNER_UID = CONFIG["ownerUid"]',
  'globals().update({key: value for key, value in vars(_module).items() if not key.startswith("_")})',
  'if __name__ == "__main__":',
  '    raise SystemExit(_module.main(sys.argv[1:]))',
  '',
].join('\n');

/**
 * Aborts the commit program at a chosen rename so a crash artifact can be
 * inspected, and traces unit control and renames in one ordered stream so their
 * interleaving is observable. No systemctl binary is ever executed.
 */
const DRIVER_SOURCE = [
  'import os, runpy, subprocess, sys',
  'limit = int(sys.argv[1])',
  'program = sys.argv[2]',
  'sys.argv = [program] + sys.argv[3:]',
  'real = os.replace',
  'performed = []',
  'def replace(source, target, **keywords):',
  '    if len(performed) >= limit:',
  '        raise SystemExit("injected crash")',
  '    performed.append(target)',
  '    print("rename:" + os.path.basename(target), flush=True)',
  '    return real(source, target, **keywords)',
  'os.replace = replace',
  'def run(argv, **keywords):',
  '    print("run:" + " ".join(argv), flush=True)',
  '    return subprocess.CompletedProcess(argv, int(os.environ.get("STOP_STATUS", "0")), b"", b"")',
  'subprocess.run = run',
  'runpy.run_path(program, run_name="__main__")',
  '',
].join('\n');

function policyHarness(options: { env?: string; networks?: Network[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rtsp-policy-'));
  const etc = join(root, 'etc');
  const app = join(root, 'app');
  mkdirSync(etc);
  mkdirSync(app);
  const envPath = join(app, '.env');
  const policyPath = join(etc, 'live-stream-policy.json');
  const summaryPath = join(etc, 'live-stream-policy.summary.json');
  const configPath = join(root, 'inspector.json');
  const inspector = join(root, 'live-stream-policy-inspector');
  const stageProgram = join(root, 'stage.py');
  const commitProgram = join(root, 'commit.py');
  const driver = join(root, 'driver.py');

  writeFileSync(envPath, options.env ?? 'TIMEZONE=UTC\n', { mode: 0o600 });
  chmodSync(envPath, 0o600);
  const setNetworks = (networks: Network[]) =>
    writeFileSync(configPath, JSON.stringify({ networks, summaryPath, ownerUid: OWNER_UID }));
  setNetworks(options.networks ?? [ETH0]);
  writeFileSync(inspector, inspectorSource(configPath));
  chmodSync(inspector, 0o755);
  writeFileSync(stageProgram, heredoc(STAGE_MARKER));
  writeFileSync(commitProgram, heredoc(COMMIT_MARKER));
  writeFileSync(driver, DRIVER_SOURCE);

  // Staging emits the identity of the env file it read; the commit refuses to
  // overwrite anything else, so the harness carries it exactly as the shell does.
  let envIdentity = '';
  const stage = (over: { env?: string; workerUid?: number; streamUid?: number } = {}) => {
    envIdentity = execFileSync('python3', [
      stageProgram, inspector, over.env ?? envPath, policyPath, summaryPath,
      String(OWNER_UID), String(OWNER_GID),
      String(over.workerUid ?? OWNER_UID), String(over.streamUid ?? STREAM_UID),
    ], { encoding: 'utf8', stdio: 'pipe' }).trim();
    return envIdentity;
  };
  // The commit program stops the helper only when its unit is installed, which
  // a fresh install has not reached yet; `unit` chooses which case is under test.
  const unitPath = join(root, 'homeworker-stream-net.service');
  const commit = (
    renames = 3,
    identity = () => envIdentity,
    options: { unit?: boolean; stopStatus?: number } = {},
  ) => {
    if (options.unit) writeFileSync(unitPath, '[Unit]\n');
    else rmSync(unitPath, { force: true });
    return execFileSync('python3', [
      driver, String(renames), commitProgram, inspector, policyPath, summaryPath, envPath, unitPath,
      String(OWNER_UID), String(OWNER_GID), String(OWNER_UID), identity(),
    ], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, STOP_STATUS: String(options.stopStatus ?? 0) } });
  };
  const install = (over?: Parameters<typeof stage>[0]) => { stage(over); commit(); };
  const verifyInstalled = () =>
    JSON.parse(execFileSync(inspector, ['verify-installed'], { encoding: 'utf8' })) as {
      ready: boolean; reason: string | null; digest: string | null;
    };
  const settings = () => Object.fromEntries(
    readFileSync(envPath, 'utf8').split('\n')
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  ) as Record<string, string>;

  return {
    root, etc, app, envPath, policyPath, summaryPath, inspector,
    setNetworks, stage, commit, install, verifyInstalled, settings,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

type Harness = ReturnType<typeof policyHarness>;

/** Runs the real privileged routine against stubbed sudo/id/getent and a fixture inspector. */
function routineHarness(networks: Network[], options: { entry?: string; aptStatus?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rtsp-privileged-routine-'));
  const bin = join(root, 'bin');
  const bundle = join(root, 'bundle');
  const app = join(root, 'app');
  const etc = join(root, 'etc');
  const log = join(root, 'commands.log');
  execFileSync('mkdir', ['-p', bin, join(bundle, 'systemd'), app, join(etc, 'ca')]);
  writeFileSync(join(app, '.env'), 'RTSP_ALLOWED_CIDRS=192.168.0.0/16\n', { mode: 0o600 });
  chmodSync(join(app, '.env'), 0o600);
  const configPath = join(root, 'inspector.json');
  writeFileSync(configPath, JSON.stringify({
    networks,
    summaryPath: join(etc, 'live-stream-policy.summary.json'),
    ownerUid: OWNER_UID,
  }));
  writeFileSync(join(bundle, 'live-stream-policy-inspector'), inspectorSource(configPath));
  chmodSync(join(bundle, 'live-stream-policy-inspector'), 0o755);
  for (const name of ['homeworker-ffmpeg-stream@.service', 'homeworker-stream-net.service', 'homeworker-stream-systemd.rules']) {
    writeFileSync(join(bundle, 'systemd', name), '@HOME_WORKER_USER@\n');
  }
  writeFileSync(join(bin, 'getent'), '#!/bin/sh\nexit 0\n');
  writeFileSync(join(bin, 'id'), '#!/bin/sh\nif [ "$1" = "-u" ]; then /usr/bin/id -u; else exit 1; fi\n');
  writeFileSync(join(bin, 'sudo'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\ncase "$1" in python3) shift; exec python3 "$@";; rm) shift; exec /bin/rm "$@";; apt-get) shift; exec apt-get "$@";; *) exit 0;; esac\n`);
  writeFileSync(join(bin, 'apt-get'), `#!/bin/sh\nprintf 'apt-get %s\\n' "$*" >> ${JSON.stringify(log)}\nexit ${options.aptStatus ?? 0}\n`);
  for (const name of ['getent', 'id', 'sudo', 'apt-get']) chmodSync(join(bin, name), 0o755);
  const prelude = installFeature.split(/^case "\$FEATURE" in/m)[0]
    .replaceAll('/usr/bin/sudo', join(bin, 'sudo'))
    .replaceAll('/usr/lib/home-worker', bundle)
    .replaceAll('/opt/home-worker', app)
    .replaceAll('/etc/home-worker', etc)
    .replace('local root_uid=0 root_gid=0', `local root_uid=${OWNER_UID} root_gid=${OWNER_GID}`)
    .replace('"$(id -u "$stream_user")"', `"${STREAM_UID}"`);
  const script = join(root, 'run.sh');
  writeFileSync(script, `#!/bin/bash\nset -euo pipefail\nexport PATH=${JSON.stringify(bin)}:$PATH\nHOME_WORKER_PRIVILEGED=1\n${prelude}\n${options.entry ?? 'install_rtsp_runtime'}\n`);
  chmodSync(script, 0o755);
  return { root, bin, bundle, app, etc, log, configPath, run: () => execFileSync('bash', [script], { stdio: 'pipe' }) };
}

/**
 * The reserved routine exit status the privileged helper turns into one closed
 * failure cause. A routine that merely "threw" would prove nothing about which
 * cause the operator is told, so every test names the status it expects.
 */
function routineExitStatus(run: () => unknown): number {
  try {
    run();
  } catch (error) {
    return (error as { status?: number }).status ?? -1;
  }
  throw new Error('the privileged routine unexpectedly succeeded');
}

/** The commit program's own refusal message, so a test can name the gate it hit. */
function commitFailure(harness: Harness): string {
  try {
    harness.commit();
  } catch (error) {
    return String((error as { stderr?: Buffer }).stderr ?? '');
  }
  throw new Error('the commit program accepted a tampered staged policy');
}

/** Runs the real root verification with only its fixed paths and account lookups redirected. */
function privilegedVerification(harness: Harness, overrides = ''): boolean {
  const program = [
    'import importlib.util, json, os, sys',
    'from types import SimpleNamespace',
    `spec = importlib.util.spec_from_file_location('helper', ${JSON.stringify(resolve('scripts/feature-installer.py'))})`,
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    `m.POLICY_INSPECTOR_PATH = ${JSON.stringify(harness.inspector)}`,
    `m.LIVE_STREAM_POLICY_PATH = ${JSON.stringify(harness.policyPath)}`,
    `m.LIVE_STREAM_SUMMARY_PATH = ${JSON.stringify(harness.summaryPath)}`,
    `m.WORKER_ENV_PATH = ${JSON.stringify(harness.envPath)}`,
    `m.POLICY_OWNER_UID = ${OWNER_UID}; m.POLICY_OWNER_GID = ${OWNER_GID}`,
    "m.WORKER_NAME = 'worker'; m.STREAM_NAME = 'stream'; m.STREAM_GROUP = 'streamers'",
    `accounts = {'worker': ${OWNER_UID}, 'stream': ${STREAM_UID}}`,
    'm.pwd = SimpleNamespace(getpwnam=lambda name: SimpleNamespace(pw_uid=accounts[name]))',
    "m.grp = SimpleNamespace(getgrnam=lambda name: SimpleNamespace(gr_gid={'streamers': 0}[name]))",
    overrides,
    "print(json.dumps([m.rtsp_policy_installed(), m.rtsp_policy_rejection()]))",
  ].join('\n');
  const [ok, reason] = JSON.parse(
    execFileSync('python3', ['-c', program], { encoding: 'utf8' }),
  ) as [boolean, string | null];
  lastRejection = reason;
  return ok;
}

/** Closed reason token from the most recent privilegedVerification call. */
let lastRejection: string | null = null;

const canonical = (raw: string) => JSON.stringify(JSON.parse(raw), CANONICAL_KEYS) + '\n';

/** The very digest function the installer calls, so its inputs can be varied directly. */
function policyDigest(harness: Harness, workerUid: number, streamUid: number, networks: Network[]): string {
  const program = [
    'import importlib.machinery, importlib.util, json',
    `loader = importlib.machinery.SourceFileLoader('inspector', ${JSON.stringify(harness.inspector)})`,
    'm = importlib.util.module_from_spec(importlib.util.spec_from_loader(loader.name, loader))',
    'loader.exec_module(m)',
    `entries = [m.EligibleNetwork(**entry) for entry in json.loads(${JSON.stringify(JSON.stringify(networks))})]`,
    `print(m.policy_digest(m.POLICY_VERSION, ${workerUid}, ${streamUid}, entries, 24000, 24001))`,
  ].join('\n');
  return execFileSync('python3', ['-c', program], { encoding: 'utf8' }).trim();
}

describe('restricted RTSP runtime installation', () => {
  const install = readFileSync(resolve('scripts/install.sh'), 'utf8');
  const deps = readFileSync(resolve('config/system-deps.yml'), 'utf8');

  it('installs the restricted runtime dependencies and root-owned assets without broad sudoers', () => {
    expect(deps).toMatch(/rtsp:[\s\S]*- ffmpeg[\s\S]*- nftables[\s\S]*- cloudflared/);
    expect(installFeature).toContain('homeworker-stream-net.service');
    expect(installFeature).toContain('homeworker-ffmpeg-stream@.service');
    expect(installFeature).toContain('live-stream-net-helper');
    expect(installFeature).toContain('live-stream-ffmpeg-runner');
    expect(installFeature).toContain('homeworker-stream-systemd.rules');
    expect(installFeature).toContain('systemctl restart homeworker-stream-net.service');
    expect(installFeature).toContain('systemctl is-active --quiet homeworker-stream-net.service');
    expect(installFeature).toContain('apt_get install -y ffmpeg nftables polkitd pkexec');
    expect(installFeature).not.toMatch(/apt_get install[^\n]*policykit-1/);
    expect(installFeature).toContain('d /run/home-worker/live-source-probe 0700 $USER $USER');
    expect(installFeature).not.toMatch(/sudoers[\s\S]*homeworker-ffmpeg-stream/);
    expect(installFeature).not.toMatch(/NOPASSWD:[^\n]*(?:nft|homeworker-ffmpeg|homeworker-stream-net)/);
    expect(install).toContain("includes('rtsp')");
  });

  it('creates a locked no-login no-home stream identity and keeps the single private env path', () => {
    expect(installFeature).toMatch(/useradd[^\n]*(?:--system|-r)[^\n]*(?:--no-create-home|-M)/);
    expect(installFeature).toContain('/usr/sbin/nologin');
    expect(installFeature).toContain('usermod -L "$stream_user"');
    expect(installFeature).not.toContain('$STREAM_USER');
    expect(installFeature).toContain('RTSP_CREDENTIALS_KEY');
    // The private worker environment is spelled exactly once, and every other
    // reference derives from it, so no second env path can creep in.
    expect(installFeature).toContain('RTSP_ENV_FILE="$INSTALL_DIR/.env"');
    expect(installFeature.match(/INSTALL_DIR\/\.env/g)).toHaveLength(1);
    expect(installFeature).toContain('local env_file="$RTSP_ENV_FILE"');
    expect(installFeature).not.toMatch(/echo[^\n]*RTSP_CREDENTIALS_KEY[^\n]*\$RTSP_CREDENTIALS_KEY/);
    expect(installFeature).toContain('restart the worker supervisor to refresh its homeworker-stream group membership');
    expect(installFeature).toMatch(/HOME_WORKER_RTSP_SKIP_RUNTIME_INSTALL[^\n]*VITEST/);
    expect(install).toContain('RTSP_GROUP_REFRESH_REQUIRED=1');
    expect(install).toContain('pm2 kill');
    expect(install.indexOf('pm2 kill')).toBeLessThan(install.indexOf('pm2 jlist'));
  });

  it('reaches the policy inspector through the root bundle, never the application tree', () => {
    expect(installFeature).toContain('inspector="$SCRIPT_DIR/live-stream-policy-inspector"');
    expect(installFeature).not.toContain('$INSTALL_DIR/live-stream-policy-inspector');
    expect(installFeature).not.toContain('$INSTALL_DIR/scripts');
  });

  it('refuses the pre-package gate when discovery reports no eligible network', () => {
    const empty = policyHarness({ networks: [] });
    const present = policyHarness();
    const runGate = (harness: Harness) => {
      const program = join(harness.root, 'gate.py');
      writeFileSync(program, heredoc(GATE_MARKER));
      return execFileSync('python3', [program, harness.inspector], { encoding: 'utf8', stdio: 'pipe' });
    };
    try {
      let rejection = '';
      let status = 0;
      try {
        runGate(empty);
      } catch (error) {
        rejection = String((error as { stderr?: Buffer }).stderr ?? '');
        status = (error as { status?: number }).status ?? -1;
      }
      expect(rejection).toContain('no eligible local network');
      // "Nothing eligible" is its own reserved status; a discovery that fails
      // instead must not borrow it.
      expect(status).toBe(20);
      writeFileSync(empty.inspector, [
        `#!${PYTHON}`, 'import sys', 'POLICY_VERSION = 2',
        'def strict_json_loads(text): raise ValueError("unused")',
        'if __name__ == "__main__": sys.exit(9)', '',
      ].join('\n'));
      chmodSync(empty.inspector, 0o755);
      expect(routineExitStatus(() => runGate(empty))).not.toBe(20);
      expect(() => runGate(present)).not.toThrow();
    } finally {
      empty.cleanup();
      present.cleanup();
    }
  });

  it('refuses to stage any policy when no local network is eligible', () => {
    const harness = policyHarness({ networks: [] });
    try {
      const before = readFileSync(harness.envPath, 'utf8');
      expect(() => harness.stage()).toThrow();
      expect(existsSync(`${harness.policyPath}.staged`)).toBe(false);
      expect(existsSync(`${harness.summaryPath}.staged`)).toBe(false);
      expect(existsSync(`${harness.envPath}.staged`)).toBe(false);
      expect(existsSync(harness.policyPath)).toBe(false);
      expect(existsSync(harness.summaryPath)).toBe(false);
      expect(readFileSync(harness.envPath, 'utf8')).toBe(before);
    } finally {
      harness.cleanup();
    }
  });

  it('stages one deterministic canonical tuple and only then commits it', () => {
    const harness = policyHarness();
    try {
      const before = readFileSync(harness.envPath, 'utf8');
      harness.stage();
      const staged = readFileSync(`${harness.policyPath}.staged`, 'utf8');
      expect(readFileSync(`${harness.summaryPath}.staged`, 'utf8')).toBe(staged);
      expect(staged).toBe(canonical(staged));
      expect(JSON.parse(staged)).toMatchObject({
        version: 2, workerUid: OWNER_UID, streamUid: STREAM_UID,
        networks: [ETH0], udpPortFirst: 24000, udpPortLast: 24001,
      });
      expect(JSON.parse(staged).digest).toMatch(/^[0-9a-f]{64}$/);
      // Staging alone never touches a durable artifact.
      expect(existsSync(harness.policyPath)).toBe(false);
      expect(existsSync(harness.summaryPath)).toBe(false);
      expect(readFileSync(harness.envPath, 'utf8')).toBe(before);

      harness.commit();
      expect(readFileSync(harness.policyPath, 'utf8')).toBe(staged);
      expect(readFileSync(harness.summaryPath, 'utf8')).toBe(staged);
      expect(harness.verifyInstalled()).toMatchObject({ ready: true, reason: null, digest: JSON.parse(staged).digest });
      expect(privilegedVerification(harness)).toBe(true);
      const settings = harness.settings();
      expect(settings.RTSP_ALLOWED_CIDRS).toBe('192.168.1.0/24');
      expect(settings.RTSP_POLICY_DIGEST).toBe(JSON.parse(staged).digest);
      expect(settings.RTSP_CREDENTIALS_KEY).toMatch(/^[0-9a-f]{64}$/);
      expect(settings.TIMEZONE).toBe('UTC');
    } finally {
      harness.cleanup();
    }
  });

  it('changes the digest when the interface, CIDR, stream UID, or UDP range changes', () => {
    const digests = new Map<string, string>();
    const record = (label: string, options: Parameters<typeof policyHarness>[0], over?: Parameters<Harness['stage']>[0]) => {
      const harness = policyHarness(options);
      try {
        harness.install(over);
        digests.set(label, JSON.parse(readFileSync(harness.policyPath, 'utf8')).digest as string);
      } finally {
        harness.cleanup();
      }
    };
    record('baseline', {});
    record('interface', { networks: [{ ...ETH0, interface: 'wlan0' }] });
    record('cidr', { networks: [{ family: 4, cidr: '10.0.0.0/24', interface: 'eth0' }] });
    record('streamUid', {}, { streamUid: STREAM_UID + 1 });
    record('udp', { env: 'RTSP_UDP_PORT_FIRST=24010\nRTSP_UDP_PORT_LAST=24011\n' });
    record('secondNetwork', {
      networks: [ETH0, { family: 4, cidr: '10.0.0.0/24', interface: 'eth1' }].sort((a, b) => (a.cidr < b.cidr ? -1 : 1)),
    });
    expect(new Set(digests.values()).size).toBe(digests.size);
  });

  it('binds the digest to the worker UID as well', () => {
    // Staging binds workerUid to the real owner of the env file, which an
    // unprivileged test cannot vary, so drive the shared digest function
    // directly and pin the installed digest to it.
    const harness = policyHarness();
    try {
      harness.install();
      const installed = JSON.parse(readFileSync(harness.policyPath, 'utf8')).digest as string;
      expect(policyDigest(harness, OWNER_UID, STREAM_UID, [ETH0])).toBe(installed);
      expect(policyDigest(harness, OWNER_UID + 7, STREAM_UID, [ETH0])).not.toBe(installed);
    } finally {
      harness.cleanup();
    }
  });

  it('fails closed for symlinked, wrong-owner, or world-readable env files', () => {
    const harness = policyHarness();
    try {
      const link = join(harness.app, 'link.env');
      symlinkSync(harness.envPath, link);
      expect(() => harness.stage({ env: link })).toThrow();
      expect(() => harness.stage({ workerUid: OWNER_UID + 1 })).toThrow();
      chmodSync(harness.envPath, 0o644);
      expect(() => harness.stage()).toThrow();
      chmodSync(harness.envPath, 0o600);
      expect(() => harness.stage()).not.toThrow();
      // An oversized environment is rejected as an unsafe env file, not
      // silently truncated and then caught downstream by the persistence check.
      writeFileSync(harness.envPath, `TIMEZONE=UTC\n${'# padding\n'.repeat(8192)}`, { mode: 0o600 });
      chmodSync(harness.envPath, 0o600);
      let rejection = '';
      try {
        harness.stage();
      } catch (error) {
        rejection = String((error as { stderr?: Buffer }).stderr ?? '');
      }
      expect(rejection).toContain('unsafe env file');
    } finally {
      harness.cleanup();
    }
  });

  it('preserves a valid credential key and unrelated settings while replacing stale CIDRs', () => {
    const harness = policyHarness({
      env: [
        '# operator notes',
        'TIMEZONE=Europe/Kyiv',
        'RTSP_ALLOWED_CIDRS=10.9.9.0/24,172.16.0.0/12',
        `RTSP_CREDENTIALS_KEY=${CREDENTIAL_KEY}`,
        'RTSP_POLICY_DIGEST=' + '0'.repeat(64),
        '',
      ].join('\n'),
    });
    try {
      harness.install();
      const updated = readFileSync(harness.envPath, 'utf8');
      expect(updated).toContain('# operator notes');
      expect(updated).toContain('TIMEZONE=Europe/Kyiv');
      const settings = harness.settings();
      expect(settings.RTSP_CREDENTIALS_KEY).toBe(CREDENTIAL_KEY);
      expect(settings.RTSP_ALLOWED_CIDRS).toBe('192.168.1.0/24');
      expect(settings.RTSP_POLICY_DIGEST).toBe(JSON.parse(readFileSync(harness.policyPath, 'utf8')).digest);
    } finally {
      harness.cleanup();
    }
  });

  it('rejects duplicated settings and a malformed non-empty credential key', () => {
    const duplicate = policyHarness({ env: 'TIMEZONE=UTC\nTIMEZONE=Europe/Kyiv\n' });
    const malformed = policyHarness({ env: 'RTSP_CREDENTIALS_KEY=not-a-key\n' });
    try {
      expect(() => duplicate.stage()).toThrow();
      expect(existsSync(`${duplicate.policyPath}.staged`)).toBe(false);
      expect(() => malformed.stage()).toThrow();
      expect(existsSync(`${malformed.policyPath}.staged`)).toBe(false);
    } finally {
      duplicate.cleanup();
      malformed.cleanup();
    }
  });

  it('blocks staging with an actionable message when a privileged UDP port is pinned', () => {
    const harness = policyHarness({ env: 'RTSP_UDP_PORT_FIRST=80\nRTSP_UDP_PORT_LAST=81\n' });
    try {
      let rejection = '';
      try {
        harness.stage();
      } catch (error) {
        rejection = String((error as { stderr?: Buffer }).stderr ?? '');
      }
      expect(rejection).toContain('1024..65535');
      expect(existsSync(`${harness.policyPath}.staged`)).toBe(false);
    } finally {
      harness.cleanup();
    }
  });

  it('treats a present-but-blank setting as unset rather than blocking the install', () => {
    const harness = policyHarness({
      env: 'RTSP_UDP_PORT_FIRST=\nRTSP_UDP_PORT_LAST=\nRTSP_CREDENTIALS_KEY=\n',
    });
    try {
      harness.install();
      expect(JSON.parse(readFileSync(harness.policyPath, 'utf8'))).toMatchObject({
        udpPortFirst: 24000, udpPortLast: 24001,
      });
      expect(harness.settings().RTSP_CREDENTIALS_KEY).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      harness.cleanup();
    }
  });

  it('upgrades a version 1 policy on disk, dropping ranges only v1 accepted', () => {
    const harness = policyHarness({
      // 100.64.0.0/10 is CGNAT/Tailscale space: v1's prefixlen>=8 && !is_global
      // rule accepted it, and an operator may well have set it by hand.
      env: 'TIMEZONE=UTC\nRTSP_ALLOWED_CIDRS=100.64.0.0/10\n',
    });
    try {
      writeFileSync(harness.policyPath, JSON.stringify({
        version: 1, workerUid: OWNER_UID, streamUid: STREAM_UID,
        allowedCidrs: ['100.64.0.0/10'], udpPortFirst: 24000, udpPortLast: 24001,
      }) + '\n', { mode: 0o600 });
      chmodSync(harness.policyPath, 0o600);
      expect(existsSync(harness.summaryPath)).toBe(false);

      harness.install();

      // Staging never reads the old policy: it is overwritten and the summary
      // is created fresh, so the upgrade needs no migration step.
      const document = JSON.parse(readFileSync(harness.policyPath, 'utf8'));
      expect(document.version).toBe(2);
      expect(document.allowedCidrs).toBeUndefined();
      expect(document.networks).toEqual([ETH0]);
      expect(existsSync(harness.summaryPath)).toBe(true);
      // The hand-set CGNAT range is silently gone: v2 binds to what the
      // inspector actually discovers on a physical interface.
      expect(harness.settings().RTSP_ALLOWED_CIDRS).toBe('192.168.1.0/24');
      expect(harness.settings().TIMEZONE).toBe('UTC');
      expect(privilegedVerification(harness)).toBe(true);
    } finally {
      harness.cleanup();
    }
  });

  it('is idempotent across a reinstall on the same network', () => {
    const harness = policyHarness();
    try {
      harness.install();
      const first = [harness.policyPath, harness.summaryPath, harness.envPath].map((path) => readFileSync(path, 'utf8'));
      harness.install();
      expect([harness.policyPath, harness.summaryPath, harness.envPath].map((path) => readFileSync(path, 'utf8'))).toEqual(first);
      expect(harness.verifyInstalled().ready).toBe(true);
      expect(privilegedVerification(harness)).toBe(true);
    } finally {
      harness.cleanup();
    }
  });

  it('leaves the previous tuple intact when the commit fails before its first rename', () => {
    const harness = policyHarness();
    try {
      harness.install();
      const previous = [harness.policyPath, harness.summaryPath, harness.envPath].map((path) => readFileSync(path, 'utf8'));
      harness.setNetworks([{ family: 4, cidr: '10.4.0.0/24', interface: 'eth1' }]);
      harness.stage();
      expect(() => harness.commit(0)).toThrow();
      expect([harness.policyPath, harness.summaryPath, harness.envPath].map((path) => readFileSync(path, 'utf8'))).toEqual(previous);
      // The surviving tuple is the previous one, so it stays internally
      // consistent for root verification; only readiness sees it is stale.
      expect(privilegedVerification(harness)).toBe(true);
      expect(harness.verifyInstalled()).toMatchObject({ ready: false, reason: 'policy-stale' });

      harness.commit();
      expect(harness.verifyInstalled().ready).toBe(true);
      expect(privilegedVerification(harness)).toBe(true);
    } finally {
      harness.cleanup();
    }
  });

  it('stops the running helper before the first durable rename', () => {
    const harness = policyHarness();
    try {
      harness.install();
      harness.setNetworks([{ family: 4, cidr: '10.4.0.0/24', interface: 'eth1' }]);
      harness.stage();
      // A live helper holds the stream UID it read at start, so none may span
      // the mixed tuple the three renames create.
      expect(harness.commit(3, undefined, { unit: true }).trim().split('\n')).toEqual([
        'run:/bin/systemctl stop homeworker-stream-net.service',
        'rename:live-stream-policy.json',
        'rename:live-stream-policy.summary.json',
        'rename:.env',
      ]);
    } finally {
      harness.cleanup();
    }
  });

  it('has no helper to stop on a first install that has not reached unit activation', () => {
    const harness = policyHarness();
    try {
      harness.stage();
      expect(harness.commit(3, undefined, { unit: false }).trim().split('\n')).toEqual([
        'rename:live-stream-policy.json',
        'rename:live-stream-policy.summary.json',
        'rename:.env',
      ]);
      expect(harness.verifyInstalled().ready).toBe(true);
    } finally {
      harness.cleanup();
    }
  });

  it('keeps the previous tuple whole when the running helper refuses to stop', () => {
    const harness = policyHarness();
    try {
      harness.install();
      const previous = [harness.policyPath, harness.summaryPath, harness.envPath].map((path) => readFileSync(path, 'utf8'));
      harness.setNetworks([{ family: 4, cidr: '10.4.0.0/24', interface: 'eth1' }]);
      harness.stage();
      expect(() => harness.commit(3, undefined, { unit: true, stopStatus: 1 })).toThrow();
      expect([harness.policyPath, harness.summaryPath, harness.envPath].map((path) => readFileSync(path, 'utf8'))).toEqual(previous);
      expect(privilegedVerification(harness)).toBe(true);
    } finally {
      harness.cleanup();
    }
  });

  it('rejects the mixed tuple a crash after the private-policy rename leaves behind', () => {
    const harness = policyHarness();
    try {
      harness.stage();
      expect(() => harness.commit(1)).toThrow();
      expect(existsSync(harness.policyPath)).toBe(true);
      expect(existsSync(harness.summaryPath)).toBe(false);
      expect(harness.verifyInstalled()).toMatchObject({ ready: false, reason: 'policy-summary-invalid' });
      expect(privilegedVerification(harness)).toBe(false);

      harness.stage();
      harness.commit();
      expect(harness.verifyInstalled().ready).toBe(true);
      expect(privilegedVerification(harness)).toBe(true);
    } finally {
      harness.cleanup();
    }
  });

  it('rejects the mixed tuple a crash after the public-summary rename leaves behind', () => {
    const harness = policyHarness();
    try {
      harness.stage();
      expect(() => harness.commit(2)).toThrow();
      const digest = JSON.parse(readFileSync(harness.summaryPath, 'utf8')).digest as string;
      // The public pair is already current while the private environment is not,
      // which is exactly the disagreement both readiness paths must refuse.
      expect(harness.settings().RTSP_POLICY_DIGEST).not.toBe(digest);
      expect(privilegedVerification(harness)).toBe(false);

      harness.stage();
      harness.commit();
      expect(harness.settings().RTSP_POLICY_DIGEST).toBe(
        JSON.parse(readFileSync(harness.summaryPath, 'utf8')).digest,
      );
      expect(harness.verifyInstalled().ready).toBe(true);
      expect(privilegedVerification(harness)).toBe(true);
    } finally {
      harness.cleanup();
    }
  });

  it('refuses to commit onto an environment file replaced since staging', () => {
    const harness = policyHarness();
    try {
      harness.stage();
      // A concurrent rewrite of .env is a different inode: committing the
      // staged settings would silently discard whatever it now holds.
      const replaced = join(harness.app, 'replacement');
      writeFileSync(replaced, 'TIMEZONE=UTC\nOPERATOR_EDIT=1\n', { mode: 0o600 });
      chmodSync(replaced, 0o600);
      renameSync(replaced, harness.envPath);
      expect(() => harness.commit()).toThrow();
      expect(readFileSync(harness.envPath, 'utf8')).toContain('OPERATOR_EDIT=1');
      // Both public artifacts were renamed before the environment is checked?
      // No -- the identity check runs before the first rename.
      expect(existsSync(harness.policyPath)).toBe(false);
      expect(existsSync(harness.summaryPath)).toBe(false);
    } finally {
      harness.cleanup();
    }
  });

  it('never adopts a staged file it did not create in the worker-writable directory', () => {
    const harness = policyHarness();
    try {
      // The worker owns $INSTALL_DIR, so it can pre-place .env.staged -- as a
      // hard link to a file of its choosing. Truncating and adopting that name
      // would write the policy environment straight through the link, so root
      // has to unlink first and create the staged file exclusively.
      const victim = join(harness.app, 'victim');
      const planted = `${harness.envPath}.staged`;
      writeFileSync(victim, 'UNTOUCHED\n', { mode: 0o600 });
      linkSync(victim, planted);
      expect(() => harness.stage()).not.toThrow();
      expect(readFileSync(victim, 'utf8')).toBe('UNTOUCHED\n');
      expect(readFileSync(planted, 'utf8')).toContain('RTSP_ALLOWED_CIDRS=');
      const staging = heredoc(STAGE_MARKER);
      expect(staging).toContain('os.O_EXCL');
    } finally {
      harness.cleanup();
    }
  });

  it('discards the staged tuple, credential key included, when the commit fails', () => {
    const routine = installFeature.slice(
      installFeature.indexOf('install_rtsp_runtime() {'),
      installFeature.indexOf('case "$FEATURE" in'),
    );
    // Staging failure, package failure, and commit failure all clean up.
    expect(routine.match(/discard_staged_rtsp_policy "\$policy_file" "\$summary_file" "\$env_file"/g))
      .toHaveLength(3);
    const packages = routine.indexOf('apt_get install -y ffmpeg nftables polkitd pkexec');
    const commitCall = routine.indexOf('"$inspector" "$policy_file" "$summary_file" "$env_file"');
    const discards = [...routine.matchAll(/discard_staged_rtsp_policy /g)].map((match) => match.index ?? -1);
    expect(discards.filter((index) => index > packages)).toHaveLength(2);
    expect(discards.filter((index) => index > commitCall)).toHaveLength(1);
  });

  it('refuses to commit a staged tuple whose files disagree or lost their private mode', () => {
    const disagree = policyHarness();
    const exposed = policyHarness();
    try {
      disagree.stage();
      const tampered = JSON.parse(readFileSync(`${disagree.summaryPath}.staged`, 'utf8'));
      tampered.udpPortLast = 24002;
      writeFileSync(`${disagree.summaryPath}.staged`, JSON.stringify(tampered, CANONICAL_KEYS) + '\n');
      expect(() => disagree.commit()).toThrow();
      expect(existsSync(disagree.policyPath)).toBe(false);

      exposed.stage();
      chmodSync(`${exposed.policyPath}.staged`, 0o644);
      expect(() => exposed.commit()).toThrow();
      expect(existsSync(exposed.policyPath)).toBe(false);
    } finally {
      disagree.cleanup();
      exposed.cleanup();
    }
  });

  it.each([
    ['a digest that covers nothing', (staged: Record<string, unknown>) => { staged.digest = '0'.repeat(64); }],
    ['a network the inspector would never discover', (staged: Record<string, unknown>) => { (staged.networks as Record<string, unknown>[])[0].cidr = '8.8.8.0/24'; }],
    ['an unknown field', (staged: Record<string, unknown>) => { staged.streamGid = 1002; }],
  ])('refuses a staged policy carrying %s', (_label, tamper) => {
    const harness = policyHarness();
    try {
      harness.stage();
      // Both staged files carry identical bytes, so the pair check passes and
      // only the shared document parser stands between this and a commit.
      for (const path of [`${harness.policyPath}.staged`, `${harness.summaryPath}.staged`]) {
        const staged = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
        tamper(staged);
        writeFileSync(path, `${JSON.stringify(staged)}\n`);
      }
      // Name the gate, not merely the failure: a later check refusing this for
      // its own reasons would otherwise hide a parser that stopped enforcing.
      expect(commitFailure(harness)).toContain('staged policy is not canonical');
      expect(existsSync(harness.policyPath)).toBe(false);
    } finally {
      harness.cleanup();
    }
  });

  it('rejects every broken durable artifact through root verification', () => {
    const harness = policyHarness();
    try {
      harness.install();
      expect(privilegedVerification(harness)).toBe(true);

      // Wrong mode on the private policy.
      chmodSync(harness.policyPath, 0o644);
      expect(privilegedVerification(harness)).toBe(false);
      chmodSync(harness.policyPath, 0o600);

      // Wrong owner on the public summary.
      expect(privilegedVerification(harness, `m.POLICY_OWNER_UID = ${OWNER_UID + 1}`)).toBe(false);

      // Missing stream account, then missing stream group.
      expect(privilegedVerification(harness, "m.STREAM_NAME = 'absent'")).toBe(false);
      expect(lastRejection).toBe('stream-account-missing');
      expect(privilegedVerification(harness, "m.STREAM_GROUP = 'absent'")).toBe(false);
      expect(lastRejection).toBe('stream-group-missing');
      // A policy naming a worker UID the box does not actually run as. The
      // token matters: without the workerUid clause this still fails, but only
      // downstream on the environment owner, which is a different defect.
      expect(privilegedVerification(harness, `accounts['worker'] = ${OWNER_UID + 7}`)).toBe(false);
      expect(lastRejection).toBe('worker-uid-mismatch');
      expect(privilegedVerification(harness, `accounts['stream'] = ${STREAM_UID + 7}`)).toBe(false);
      expect(lastRejection).toBe('stream-uid-mismatch');

      const document = JSON.parse(readFileSync(harness.summaryPath, 'utf8'));
      const rewrite = (path: string, value: unknown, mode: number) => {
        writeFileSync(path, JSON.stringify(value, CANONICAL_KEYS) + '\n');
        chmodSync(path, mode);
      };

      // Digest mismatch, non-canonical order, and out-of-range UDP ports.
      rewrite(harness.summaryPath, { ...document, digest: '0'.repeat(64) }, 0o644);
      expect(privilegedVerification(harness)).toBe(false);
      const pair = [
        { family: 4, cidr: '192.168.2.0/24', interface: 'eth1' },
        { family: 4, cidr: '192.168.1.0/24', interface: 'eth0' },
      ];
      rewrite(harness.summaryPath, { ...document, networks: pair }, 0o644);
      expect(privilegedVerification(harness)).toBe(false);
      rewrite(harness.summaryPath, { ...document, udpPortFirst: 80, udpPortLast: 81 }, 0o644);
      expect(privilegedVerification(harness)).toBe(false);

      // A private policy that no longer matches the public summary.
      rewrite(harness.summaryPath, document, 0o644);
      rewrite(harness.policyPath, { ...document, streamUid: STREAM_UID + 5 }, 0o600);
      expect(privilegedVerification(harness)).toBe(false);
      rewrite(harness.policyPath, document, 0o600);
      expect(privilegedVerification(harness)).toBe(true);

      // Missing files.
      rmSync(harness.summaryPath);
      expect(privilegedVerification(harness)).toBe(false);
      expect(lastRejection).toBe('summary-missing');
      rmSync(harness.policyPath);
      expect(privilegedVerification(harness)).toBe(false);
      expect(lastRejection).toBe('policy-missing');
    } finally {
      harness.cleanup();
    }
  });

  it('names a closed reason for every refusal without ever quoting an artifact', () => {
    const harness = policyHarness();
    try {
      harness.install();
      expect(privilegedVerification(harness)).toBe(true);
      expect(lastRejection).toBeNull();

      const secret = harness.settings().RTSP_CREDENTIALS_KEY;
      const observed: string[] = [];
      const record = (overrides = '') => {
        privilegedVerification(harness, overrides);
        observed.push(lastRejection ?? '');
      };

      chmodSync(harness.policyPath, 0o644);
      record();
      chmodSync(harness.policyPath, 0o600);
      record(`m.POLICY_OWNER_UID = ${OWNER_UID + 1}`);
      record("m.WORKER_NAME = 'absent'");
      record(`m.WORKER_ENV_PATH = ${JSON.stringify(join(harness.app, 'nope'))}`);
      const document = JSON.parse(readFileSync(harness.summaryPath, 'utf8'));
      writeFileSync(harness.summaryPath, JSON.stringify({ ...document, digest: '0'.repeat(64) }, CANONICAL_KEYS) + '\n');
      chmodSync(harness.summaryPath, 0o644);
      record();

      expect(observed).toEqual([
        'policy-mode', 'policy-owner', 'worker-account-missing',
        'environment-missing', 'summary-invalid',
      ]);
      // Tokens only: never a policy field, a CIDR, or the credential key.
      for (const token of observed) {
        expect(token).toMatch(/^[a-z-]+$/);
        expect(token).not.toContain(secret);
      }
    } finally {
      harness.cleanup();
    }
  });

  it('ships a hardened bounded stream unit with no worker env, database, home, or second output transport', () => {
    const unit = readFileSync(resolve('systemd/homeworker-ffmpeg-stream@.service'), 'utf8');
    expect(unit).toContain('User=homeworker-stream');
    expect(unit).toContain('NoNewPrivileges=yes');
    expect(unit).toContain('PrivateTmp=yes');
    expect(unit).toContain('ProtectHome=yes');
    expect(unit).toContain('ProtectSystem=strict');
    expect(unit).toContain('InaccessiblePaths=-/opt/home-worker/.env -/opt/home-worker/data');
    expect(unit).toMatch(/RuntimeMaxSec=(?:[1-9]\d?|[12]\d\d|300)/);
    expect(unit).toMatch(/MemoryMax=\S+/);
    expect(unit).toMatch(/CPUQuota=\S+/);
    expect(unit).toContain('RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6');
    expect(unit).not.toContain('EnvironmentFile=');
    expect(unit).not.toMatch(/\.db|\/home\//);
    const helperUnit = readFileSync(resolve('systemd/homeworker-stream-net.service'), 'utf8');
    expect(helperUnit).not.toContain('CAP_DAC_OVERRIDE');
    // A table outliving its helper still carries the catch-alls of the policy
    // that helper read at start, under a chain whose policy is accept.
    expect(helperUnit).toContain('ExecStopPost=-/usr/sbin/nft delete table inet homeworker_stream');
    // Deleting that table on stop is only safe because readiness is reported
    // after the rules load, so nothing ordered After= starts into the gap.
    expect(helperUnit).toContain('Type=notify');
    expect(helperUnit).toContain('NotifyAccess=main');
    expect(helperUnit).not.toContain('Type=simple');
    expect(helperUnit).toMatch(/TimeoutStartSec=(?:[1-9]\d?|[12]\d\d|300)\b/);
  });

  it('has syntactically valid shell and Python runtime assets', () => {
    execFileSync('bash', ['-n', resolve('scripts/install-feature.sh')]);
    execFileSync('python3', ['-m', 'py_compile', resolve('scripts/live-stream-net-helper')]);
    execFileSync('python3', ['-m', 'py_compile', resolve('scripts/live-stream-ffmpeg-runner')]);
    execFileSync('python3', ['-m', 'py_compile', resolve('scripts/feature-installer.py')]);
  });

  it('runs the privileged RTSP routine through policy and unit activation without self-copying bundle executables', () => {
    const { root, bundle, app, etc, log, run } = routineHarness([ETH0]);
    try {
      run();
      const commands = readFileSync(log, 'utf8');
      expect(commands).toContain('systemctl daemon-reload');
      expect(commands).toContain('systemctl restart homeworker-stream-net.service');
      expect(commands).toContain('systemctl is-active --quiet homeworker-stream-net.service');
      expect(commands).not.toContain(`install -m 0755 -o root -g root ${bundle}/live-stream-net-helper ${bundle}/live-stream-net-helper`);
      expect(commands).not.toContain(`install -m 0755 -o root -g root ${bundle}/live-stream-ffmpeg-runner ${bundle}/live-stream-ffmpeg-runner`);
      // The routine committed all three durable artifacts and left no staged file.
      const policy = readFileSync(join(etc, 'live-stream-policy.json'), 'utf8');
      expect(readFileSync(join(etc, 'live-stream-policy.summary.json'), 'utf8')).toBe(policy);
      expect(JSON.parse(policy)).toMatchObject({ version: 2, networks: [ETH0], streamUid: STREAM_UID });
      const updated = readFileSync(join(app, '.env'), 'utf8');
      expect(updated).toContain('RTSP_ALLOWED_CIDRS=192.168.1.0/24');
      expect(updated).toContain(`RTSP_POLICY_DIGEST=${JSON.parse(policy).digest}`);
      expect(existsSync(join(etc, 'live-stream-policy.json.staged'))).toBe(false);
      expect(existsSync(join(app, '.env.staged'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('aborts the privileged routine before package mutation when nothing is eligible', () => {
    const { root, app, etc, log, run } = routineHarness([]);
    try {
      const before = readFileSync(join(app, '.env'), 'utf8');
      expect(routineExitStatus(run)).toBe(20);
      // Neither the durable tuple nor a staged file nor a package appeared.
      expect(existsSync(join(etc, 'live-stream-policy.json'))).toBe(false);
      expect(existsSync(join(etc, 'live-stream-policy.summary.json'))).toBe(false);
      expect(existsSync(join(etc, 'live-stream-policy.json.staged'))).toBe(false);
      expect(existsSync(join(app, '.env.staged'))).toBe(false);
      expect(readFileSync(join(app, '.env'), 'utf8')).toBe(before);
      expect(readFileSync(log, 'utf8')).not.toContain('apt-get');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reserves one exit status per RTSP install cause, from the gate to the activation tail', () => {
    // 20 -- the pre-package gate found nothing eligible.
    const gate = routineHarness([], { entry: 'require_eligible_local_network' });
    try {
      expect(routineExitStatus(gate.run)).toBe(20);
      expect(readFileSync(gate.log, 'utf8')).not.toContain('apt-get');
    } finally {
      rmSync(gate.root, { recursive: true, force: true });
    }

    // 21 -- discovery itself failed, which is not the same as "nothing eligible".
    const broken = routineHarness([ETH0], { entry: 'require_eligible_local_network' });
    try {
      writeFileSync(broken.configPath, 'not json');
      expect(routineExitStatus(broken.run)).toBe(21);
      expect(readFileSync(broken.log, 'utf8')).not.toContain('apt-get');
    } finally {
      rmSync(broken.root, { recursive: true, force: true });
    }

    // 21 -- staging refused before any package or durable mutation.
    const staging = routineHarness([ETH0]);
    try {
      chmodSync(join(staging.app, '.env'), 0o644);
      expect(routineExitStatus(staging.run)).toBe(21);
      expect(readFileSync(staging.log, 'utf8')).not.toContain('apt-get');
      expect(existsSync(join(staging.etc, 'live-stream-policy.json'))).toBe(false);
      expect(existsSync(join(staging.app, '.env.staged'))).toBe(false);
    } finally {
      rmSync(staging.root, { recursive: true, force: true });
    }

    // 22 -- the package command failed, with the durable tuple still untouched.
    const packages = routineHarness([ETH0], { aptStatus: 100 });
    try {
      expect(routineExitStatus(packages.run)).toBe(22);
      expect(readFileSync(packages.log, 'utf8')).toContain('apt-get');
      expect(existsSync(join(packages.etc, 'live-stream-policy.json'))).toBe(false);
      expect(existsSync(join(packages.etc, 'live-stream-policy.json.staged'))).toBe(false);
      expect(existsSync(join(packages.app, '.env.staged'))).toBe(false);
    } finally {
      rmSync(packages.root, { recursive: true, force: true });
    }

    // 23 -- the commit program refused, which the shell reports as a privileged
    // failure whether or not a rename had already landed. A durable target that
    // is a directory makes the first rename fail inside the commit region.
    const commitFail = routineHarness([ETH0]);
    try {
      mkdirSync(join(commitFail.etc, 'live-stream-policy.json'));
      expect(routineExitStatus(commitFail.run)).toBe(23);
      expect(existsSync(join(commitFail.app, '.env.staged'))).toBe(false);
    } finally {
      rmSync(commitFail.root, { recursive: true, force: true });
    }

    // 23 -- the tuple is committed and the activation tail failed, so the
    // helper may be stopped and only a privileged reinstall can reconcile it.
    const activation = routineHarness([ETH0]);
    try {
      rmSync(join(activation.bundle, 'systemd', 'homeworker-stream-systemd.rules'));
      expect(routineExitStatus(activation.run)).toBe(23);
      expect(existsSync(join(activation.etc, 'live-stream-policy.json'))).toBe(true);
    } finally {
      rmSync(activation.root, { recursive: true, force: true });
    }
  });

  it('reserves the privileged failure status from the stop attempt onward', () => {
    const beforeRename = policyHarness();
    try {
      beforeRename.install();
      beforeRename.setNetworks([{ family: 4, cidr: '10.4.0.0/24', interface: 'eth1' }]);
      beforeRename.stage();
      // Stopped but never restarted: the stop succeeded and the first rename
      // never happened, so the durable tuple survives but the helper is down.
      expect(routineExitStatus(() => beforeRename.commit(0, undefined, { unit: true }))).toBe(23);
      // A stop that refuses aborts in the same region and reports the same cause.
      expect(routineExitStatus(() => beforeRename.commit(3, undefined, { unit: true, stopStatus: 1 }))).toBe(23);
    } finally {
      beforeRename.cleanup();
    }

    const afterRename = policyHarness();
    try {
      afterRename.stage();
      expect(routineExitStatus(() => afterRename.commit(1))).toBe(23);
    } finally {
      afterRename.cleanup();
    }
  });

  it('authorizes only UUID stream instances and start/stop verbs through Polkit', () => {
    const rule = readFileSync(resolve('systemd/homeworker-stream-systemd.rules'), 'utf8');
    expect(rule).toContain('org.freedesktop.systemd1.manage-units');
    expect(rule).toContain('action.lookup("unit")');
    expect(rule).toContain('action.lookup("verb")');
    expect(rule).toContain('subject.user');
    expect(rule).not.toContain('polkit.spawn');
    const evaluate = (unit: string, verb: string) => {
      let callback: ((action: { id: string; lookup(key: string): string }, subject: { user: string }) => unknown) | undefined;
      const polkit = { Result: { YES: 'YES' }, addRule: (value: typeof callback) => { callback = value; } };
      runInNewContext(rule.replaceAll('@HOME_WORKER_USER@', 'homeworker'), { polkit });
      return callback?.({ id: 'org.freedesktop.systemd1.manage-units', lookup: (key) => key === 'unit' ? unit : verb }, { user: 'homeworker' });
    };
    expect(evaluate(`homeworker-ffmpeg-stream@${'01901f4c-b7f4-4c6a-a787-3f8a442c85d2'}.service`, 'start')).toBe('YES');
    expect(evaluate('ssh.service', 'start')).toBeUndefined();
    expect(evaluate('homeworker-ffmpeg-stream@x.service', 'start')).toBeUndefined();
    expect(evaluate(`homeworker-ffmpeg-stream@${'01901f4c-b7f4-4c6a-a787-3f8a442c85d2'}.service`, 'restart')).toBeUndefined();
  });
});
