import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function createRepositoryHarness(architecture = 'armhf') {
  const root = mkdtempSync(join(tmpdir(), 'cloudflared-repository-harness-'));
  const bin = join(root, 'bin');
  const keyrings = join(root, 'keyrings');
  const sources = join(root, 'sources');
  const log = join(root, 'calls.log');
  const worker = process.env.USER ?? 'nobody';
  execFileSync('mkdir', ['-p', bin, keyrings, sources]);

  const script = (name: string, lines: string[]) => {
    writeFileSync(join(bin, name), ['#!/bin/bash', ...lines, ''].join('\n'));
    chmodSync(join(bin, name), 0o755);
  };
  script('sudo', [
    `printf 'sudo:%s\n' "$*" >> '${log}'`,
    'if [ "$1" = "-H" ]; then shift; fi',
    'if [ "$1" = "-u" ]; then shift 2; fi',
    'exec "$@"',
  ]);
  script('dpkg', [
    `printf 'dpkg:%s\n' "$*" >> '${log}'`,
    `[ "$1" = "--print-architecture" ] && printf '%s\n' '${architecture}'`,
  ]);
  script('curl', [
    `printf 'curl:%s\n' "$*" >> '${log}'`,
    'while (($#)); do if [ "$1" = "-o" ]; then output="$2"; shift 2; else shift; fi; done',
    'printf signed-key > "$output"',
  ]);
  script('install', [
    `printf 'install:%s\n' "$*" >> '${log}'`,
    'args=()',
    'while (($#)); do case "$1" in -o|-g) shift 2 ;; *) args+=("$1"); shift ;; esac; done',
    'exec /usr/bin/install "${args[@]}"',
  ]);
  const cloudflaredTemplate = join(root, 'cloudflared-template');
  writeFileSync(cloudflaredTemplate, [
    '#!/bin/sh',
    `printf 'cloudflared:%s\n' "$*" >> '${log}'`,
    'exit 0',
    '',
  ].join('\n'));
  chmodSync(cloudflaredTemplate, 0o755);
  script('apt-get', [
    `printf 'apt-get:%s\n' "$*" >> '${log}'`,
    `if [[ "$*" == *"install -y cloudflared"* ]]; then cp '${cloudflaredTemplate}' '${join(bin, 'cloudflared')}'; chmod 755 '${join(bin, 'cloudflared')}'; fi`,
  ]);

  const run = () => execFileSync('bash', [resolve('scripts/install-feature.sh'), 'rtsp'], {
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      HOME_WORKER_USER: worker,
      CLOUDFLARE_KEYRING_DIR: keyrings,
      CLOUDFLARE_SOURCE_LIST_DIR: sources,
    },
  });
  return { root, keyrings, sources, log, run };
}

describe('experimental live-stream installation', () => {
  const featureScript = readFileSync(resolve('scripts/install-feature.sh'), 'utf8');
  const installScript = readFileSync(resolve('scripts/install.sh'), 'utf8');

  it('installs and diagnoses cloudflared only through the explicit rtsp feature', () => {
    expect(featureScript).toMatch(/\n {2}rtsp\)/);
    expect(featureScript).toContain('apt_get install -y cloudflared');
    expect(featureScript).toContain('"$cloudflared_bin" --config "$config" version');
    expect(featureScript).toContain('"$cloudflared_bin" --config "$config" tunnel diag');
    expect(featureScript).toContain('sudo -H -u "$USER"');
    expect(featureScript).toContain('DNS resolution and outbound port 7844');
    expect(installScript).toContain("includes('rtsp')");
  });

  it('configures the signed Cloudflare apt source before updating and installing', () => {
    const harness = createRepositoryHarness();
    try {
      harness.run();
      const calls = readFileSync(harness.log, 'utf8');
      expect(readFileSync(join(harness.keyrings, 'cloudflare-main.gpg'), 'utf8')).toBe('signed-key');
      expect(readFileSync(join(harness.sources, 'cloudflared.list'), 'utf8')).toBe(
        `deb [signed-by=${harness.keyrings}/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main\n`,
      );
      expect(calls.indexOf('curl:')).toBeLessThan(calls.indexOf('apt-get:'));
      expect(calls).toMatch(/apt-get:-o DPkg::Lock::Timeout=300 update/);
      expect(calls).toMatch(/apt-get:-o DPkg::Lock::Timeout=300 install -y cloudflared/);
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  it('leaves an already-configured signed source unchanged on rerun', () => {
    const harness = createRepositoryHarness('arm64');
    try {
      writeFileSync(join(harness.keyrings, 'cloudflare-main.gpg'), 'existing-key');
      writeFileSync(
        join(harness.sources, 'cloudflared.list'),
        `deb [signed-by=${harness.keyrings}/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main\n`,
      );
      harness.run();
      expect(readFileSync(join(harness.keyrings, 'cloudflare-main.gpg'), 'utf8')).toBe('existing-key');
      expect(readFileSync(harness.log, 'utf8')).not.toContain('curl:');
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  it('fails before repository or apt mutation on an unsupported architecture', () => {
    const harness = createRepositoryHarness('riscv64');
    try {
      expect(() => harness.run()).toThrow();
      const calls = readFileSync(harness.log, 'utf8');
      expect(calls).toContain('dpkg:--print-architecture');
      expect(calls).not.toContain('curl:');
      expect(calls).not.toContain('apt-get:');
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  it('never installs a persistent cloudflared service or changes user config', () => {
    expect(featureScript).not.toMatch(/cloudflared\s+service\s+install/);
    expect(featureScript).not.toContain('cloudflared.service');
    expect(featureScript).not.toMatch(/\.cloudflared.*(?:tee|sed|rm|mv|cp)/);
    expect(featureScript).not.toContain('trusted=yes');
    expect(featureScript).not.toContain('--allow-unauthenticated');
  });

  it('never mutates runtime opt-in state in an existing env file', () => {
    expect(featureScript).not.toContain('enable_live_stream_runtime');
    expect(featureScript).not.toContain('LIVE_STREAM_ENABLED');
    expect(featureScript).not.toMatch(/(?:sed|tee).*\.env/);
  });

  it('runs version and diagnostics as the worker with disposable config discovery', () => {
    expect(featureScript).toContain('DIAG_WORK_DIR="$DIAG_DIR/worker"');
    expect(featureScript).toContain('DIAG_HOME="$DIAG_WORK_DIR/home"');
    expect(featureScript).toContain('DIAG_CONFIG_DIR="$DIAG_WORK_DIR/config"');
    expect(featureScript).toContain('DIAG_CONFIG="$DIAG_CONFIG_DIR/config.yml"');
    expect(featureScript).toContain('HOME="$DIAG_HOME"');
    expect(featureScript).toContain('XDG_CONFIG_HOME="$DIAG_CONFIG_DIR"');
    expect(featureScript).toMatch(
      /sudo -H -u "\$USER" env -i[\s\S]*sh -c '[\s\S]*"\$cloudflared_bin" --config "\$config" version/,
    );
    expect(featureScript).toMatch(
      /sudo -H -u "\$USER" env -i[\s\S]*sh -c '[\s\S]*"\$cloudflared_bin" --config "\$config" tunnel diag/,
    );
    expect(featureScript).toContain('trap cleanup_cloudflared_diagnostics EXIT');
    expect(featureScript).toContain('sudo rm -rf "$DIAG_DIR"');
    expect(featureScript).toContain('trap - EXIT');
  });

  it('keeps apt operations bounded by the shared lock timeout', () => {
    expect(featureScript).toContain('APT_LOCK_TIMEOUT_SECONDS=300');
    expect(featureScript).toContain('DPkg::Lock::Timeout=${APT_LOCK_TIMEOUT_SECONDS}');
  });

  it('executes all private diagnostic work as the worker and cleans it as installer', () => {
    const root = mkdtempSync(join(tmpdir(), 'live-stream-installer-harness-'));
    const bin = join(root, 'bin');
    const log = join(root, 'calls.log');
    const failMode = join(root, 'fail-mode');
    const worker = process.env.USER ?? 'nobody';

    try {
      execFileSync('mkdir', ['-p', bin]);
      writeFileSync(join(bin, 'sudo'), [
        '#!/bin/sh',
        `printf 'sudo:%s\\n' "$*" >> '${log}'`,
        'if [ "$1" = "-H" ]; then shift; fi',
        'if [ "$1" = "-u" ]; then shift 2; fi',
        'exec "$@"',
        '',
      ].join('\n'));
      writeFileSync(join(bin, 'cloudflared'), [
        '#!/bin/sh',
        `printf 'cloudflared:HOME=%s:XDG=%s:PWD=%s:ARGS=%s\\n' "$HOME" "$XDG_CONFIG_HOME" "$PWD" "$*" >> '${log}'`,
        `if [ -f '${failMode}' ] && grep -q "$3" '${failMode}'; then exit 1; fi`,
        'exit 0',
        '',
      ].join('\n'));
      writeFileSync(join(bin, 'install'), [
        '#!/bin/bash',
        'args=()',
        'while (($#)); do',
        '  case "$1" in',
        '    -o|-g) shift 2 ;;',
        '    *) args+=("$1"); shift ;;',
        '  esac',
        'done',
        'exec /usr/bin/install "${args[@]}"',
        '',
      ].join('\n'));
      chmodSync(join(bin, 'sudo'), 0o755);
      chmodSync(join(bin, 'cloudflared'), 0o755);
      chmodSync(join(bin, 'install'), 0o755);

      const runInstaller = () => execFileSync(
        'bash',
        [resolve('scripts/install-feature.sh'), 'rtsp'],
        {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            HOME_WORKER_USER: worker,
            HOME_WORKER_DEBIAN_ARCH: 'amd64',
          },
        },
      );
      const expectPrivilegedCleanup = (calls: string) => {
        const diagnosticParent = (/PWD=(.*)\/worker:/.exec(calls))?.[1];
        expect(diagnosticParent).toBeDefined();
        expect(calls).toContain(`sudo:rm -rf ${diagnosticParent}`);
      };

      runInstaller();

      const calls = readFileSync(log, 'utf8');
      const cloudflaredCalls = calls.split('\n').filter((line) => line.startsWith('cloudflared:'));
      expect(calls).toContain(`sudo:-H -u ${worker} env -i`);
      expect(cloudflaredCalls).toHaveLength(2);
      for (const call of cloudflaredCalls) {
        expect(call).toMatch(/HOME=.*\/worker\/home:/);
        expect(call).toMatch(/XDG=.*\/worker\/config:/);
        expect(call).toMatch(/PWD=.*\/worker:/);
        expect(call).toContain('--config');
      }
      expectPrivilegedCleanup(calls);

      writeFileSync(failMode, 'tunnel');
      writeFileSync(log, '');
      expect(() => runInstaller()).not.toThrow();
      expectPrivilegedCleanup(readFileSync(log, 'utf8'));

      writeFileSync(failMode, 'version');
      writeFileSync(log, '');
      expect(() => runInstaller()).toThrow();
      expectPrivilegedCleanup(readFileSync(log, 'utf8'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
