import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('experimental live-stream installation', () => {
  const featureScript = readFileSync(resolve('scripts/install-feature.sh'), 'utf8');
  const installScript = readFileSync(resolve('scripts/install.sh'), 'utf8');

  it('installs and diagnoses cloudflared only through the explicit rtsp feature', () => {
    expect(featureScript).toMatch(/\n {2}rtsp\)/);
    expect(featureScript).toContain('apt_get install -y cloudflared');
    expect(featureScript).toContain('cloudflared --config "$DIAG_CONFIG" version');
    expect(featureScript).toContain('cloudflared --config "$DIAG_CONFIG" tunnel diag');
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
    expect(featureScript).toContain('DIAG_HOME="$DIAG_DIR/home"');
    expect(featureScript).toContain('DIAG_CONFIG_DIR="$DIAG_DIR/config"');
    expect(featureScript).toContain('DIAG_CONFIG="$DIAG_CONFIG_DIR/config.yml"');
    expect(featureScript).toContain('HOME="$DIAG_HOME"');
    expect(featureScript).toContain('XDG_CONFIG_HOME="$DIAG_CONFIG_DIR"');
    expect(featureScript).toMatch(
      /sudo -H -u "\$USER" env -i[\s\S]*cloudflared --config "\$DIAG_CONFIG" version/,
    );
    expect(featureScript).toMatch(
      /sudo -H -u "\$USER" env -i[\s\S]*cloudflared --config "\$DIAG_CONFIG" tunnel diag/,
    );
    expect(featureScript).toContain("trap 'rm -rf \"$DIAG_DIR\"' EXIT");
    expect(featureScript).toContain('rm -rf "$DIAG_DIR"');
    expect(featureScript).toContain('trap - EXIT');
  });

  it('keeps apt operations bounded by the shared lock timeout', () => {
    expect(featureScript).toContain('APT_LOCK_TIMEOUT_SECONDS=300');
    expect(featureScript).toContain('DPkg::Lock::Timeout=${APT_LOCK_TIMEOUT_SECONDS}');
  });
});
