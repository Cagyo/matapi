import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readScript(path: string): string {
  return readFileSync(resolve(path), 'utf8');
}

function expectLockAwareAptWrapper(script: string): void {
  expect(script).toContain('APT_LOCK_TIMEOUT_SECONDS=300');
  expect(script).toMatch(
    /apt_get\(\) \{\n {2}sudo apt-get -o "DPkg::Lock::Timeout=\$\{APT_LOCK_TIMEOUT_SECONDS\}" "\$@"\n\}/,
  );
}

describe('APT lock handling scripts', () => {
  it('uses the same bounded wait for bot-triggered system updates', () => {
    const systemUpdateScript = readScript('scripts/system-update.sh');

    expectLockAwareAptWrapper(systemUpdateScript);
    expect(systemUpdateScript).toContain('apt_get update');
    expect(systemUpdateScript).toContain(
      'apt_get install -y --only-upgrade motion ffmpeg mosquitto',
    );
    expect(systemUpdateScript).toContain('write_meta "restart_reason" "system_update"');
    expect(systemUpdateScript).toContain('write_meta "restart_reason" "system_update_failed"');
    expect(systemUpdateScript).toContain("trap 'report_failure $?' ERR");
    expect(systemUpdateScript).toMatch(
      /if write_meta "restart_reason" "system_update_failed" && pm2 restart worker; then\n\s+exit "\$exit_code"\n\s+fi\n\s+notify_failure/,
    );
    expect(systemUpdateScript.indexOf('if ! health_check; then')).toBeLessThan(
      systemUpdateScript.indexOf('write_meta "restart_reason" "system_update"'),
    );
  });

  it('keeps package and sudoers mutation out of the signed-layout gate', () => {
    const installScript = readScript('scripts/install.sh');
    const migrationScript = readScript('scripts/migrate-to-signed-ota.sh');

    expect(`${installScript}\n${migrationScript}`).not.toMatch(/apt-get|sudoers|NOPASSWD/);
  });
});
