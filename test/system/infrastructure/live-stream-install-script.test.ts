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

  it('never installs a persistent cloudflared service or changes user config', () => {
    expect(featureScript).not.toMatch(/cloudflared\s+service\s+install/);
    expect(featureScript).not.toContain('cloudflared.service');
    expect(featureScript).not.toMatch(/\.cloudflared.*(?:tee|sed|rm|mv|cp)/);
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
          },
        },
      );
      const expectPrivilegedCleanup = (calls: string) => {
        const diagnosticParent = calls.match(/PWD=(.*)\/worker:/)?.[1];
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
