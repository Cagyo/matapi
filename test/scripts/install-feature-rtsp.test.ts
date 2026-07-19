import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

describe('restricted RTSP runtime installation', () => {
  const installFeature = readFileSync(resolve('scripts/install-feature.sh'), 'utf8');
  const deps = readFileSync(resolve('config/system-deps.yml'), 'utf8');
  const envKeyProgram = (() => {
    const marker = 'sudo python3 - "$env_file" "$(id -u "$USER")" <<\'PY\'\n';
    const start = installFeature.indexOf(marker);
    if (start < 0) throw new Error('RTSP env-key program not found');
    const body = start + marker.length;
    const end = installFeature.indexOf('\nPY', body);
    return installFeature.slice(body, end);
  })();

  const runEnvKeyProgram = (path: string, expectedUid = process.getuid?.() ?? 0) => {
    const root = mkdtempSync(join(tmpdir(), 'rtsp-env-program-'));
    const program = join(root, 'program.py');
    writeFileSync(program, envKeyProgram);
    try {
      return execFileSync('python3', [program, path, String(expectedUid)], { encoding: 'utf8' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

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
  });

  it('creates a locked no-login no-home stream identity and preserves an existing credential key', () => {
    expect(installFeature).toMatch(/useradd[^\n]*(?:--system|-r)[^\n]*(?:--no-create-home|-M)/);
    expect(installFeature).toContain('/usr/sbin/nologin');
    expect(installFeature).toContain('usermod -L "$stream_user"');
    expect(installFeature).not.toContain('$STREAM_USER');
    expect(installFeature).toContain('RTSP_CREDENTIALS_KEY');
    expect(installFeature).toContain('line.startswith("RTSP_CREDENTIALS_KEY=")');
    expect(installFeature).not.toMatch(/echo[^\n]*RTSP_CREDENTIALS_KEY[^\n]*\$RTSP_CREDENTIALS_KEY/);
    expect(installFeature).toContain('restart the worker supervisor to refresh its homeworker-stream group membership');
    expect(installFeature).toMatch(/HOME_WORKER_RTSP_SKIP_RUNTIME_INSTALL[^\n]*VITEST/);
  });

  it('preserves a safe existing credential key without changing the private env file', () => {
    const root = mkdtempSync(join(tmpdir(), 'rtsp-env-safe-'));
    const path = join(root, '.env');
    const content = `RTSP_ALLOWED_CIDRS=192.168.0.0/16\nRTSP_CREDENTIALS_KEY=${'ab'.repeat(32)}\n`;
    try {
      writeFileSync(path, content, { mode: 0o600 });
      chmodSync(path, 0o600);
      runEnvKeyProgram(path);
      expect(readFileSync(path, 'utf8')).toBe(content);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed for symlinked, wrong-owner, or world-readable env files', () => {
    const root = mkdtempSync(join(tmpdir(), 'rtsp-env-unsafe-'));
    const real = join(root, 'real.env');
    const link = join(root, 'link.env');
    try {
      writeFileSync(real, `RTSP_CREDENTIALS_KEY=${'ab'.repeat(32)}\n`, { mode: 0o600 });
      chmodSync(real, 0o600);
      symlinkSync(real, link);
      expect(() => runEnvKeyProgram(link)).toThrow();
      expect(() => runEnvKeyProgram(real, (process.getuid?.() ?? 0) + 1)).toThrow();
      chmodSync(real, 0o644);
      expect(() => runEnvKeyProgram(real)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
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
  });

  it('has syntactically valid shell and Python runtime assets', () => {
    execFileSync('bash', ['-n', resolve('scripts/install-feature.sh')]);
    execFileSync('python3', ['-m', 'py_compile', resolve('scripts/live-stream-net-helper')]);
    execFileSync('python3', ['-m', 'py_compile', resolve('scripts/live-stream-ffmpeg-runner')]);
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
