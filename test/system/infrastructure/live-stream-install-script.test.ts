import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('experimental live-stream installation', () => {
  const featureScript = readFileSync(resolve('scripts/install-feature.sh'), 'utf8');
  const installScript = readFileSync(resolve('scripts/install.sh'), 'utf8');

  it('installs and diagnoses cloudflared only through the explicit rtsp feature', () => {
    expect(featureScript).toMatch(/\n {2}rtsp\)/);
    expect(featureScript).toContain('apt_get install -y cloudflared');
    expect(featureScript).toContain('cloudflared version');
    expect(featureScript).toContain('cloudflared tunnel diag');
    expect(featureScript).toContain('sudo -H -u "$USER"');
    expect(featureScript).toContain('DNS resolution and outbound port 7844');
    expect(installScript).toContain("includes('rtsp')");
  });

  it('never installs a persistent cloudflared service or changes user config', () => {
    expect(featureScript).not.toMatch(/cloudflared\s+service\s+install/);
    expect(featureScript).not.toContain('cloudflared.service');
    expect(featureScript).not.toMatch(/\.cloudflared.*(?:tee|sed|rm|mv|cp)/);
  });

  it('keeps apt operations bounded by the shared lock timeout', () => {
    expect(featureScript).toContain('APT_LOCK_TIMEOUT_SECONDS=300');
    expect(featureScript).toContain('DPkg::Lock::Timeout=${APT_LOCK_TIMEOUT_SECONDS}');
  });
});
