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
  it('waits up to five minutes for an APT/dpkg lock during installation', () => {
    const installScript = readScript('scripts/install.sh');

    expectLockAwareAptWrapper(installScript);
    expect(installScript).toContain('apt_get update');
    expect(installScript).toMatch(
      /apt_get install -y \\\n\s+git sqlite3 libsqlite3-dev build-essential python3 python3-setuptools/,
    );
  });

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

  it('keeps the sudoers allowlist aligned with the option-bearing update commands', () => {
    const installScript = readScript('scripts/install.sh');

    expect(installScript).toContain(
      '$USER ALL=(ALL) NOPASSWD: /usr/bin/apt-get -o DPkg::Lock::Timeout=300 update, /bin/apt-get -o DPkg::Lock::Timeout=300 update',
    );
    expect(installScript).toContain(
      '$USER ALL=(ALL) NOPASSWD: /usr/bin/apt-get -o DPkg::Lock::Timeout=300 install -y --only-upgrade motion ffmpeg mosquitto, /bin/apt-get -o DPkg::Lock::Timeout=300 install -y --only-upgrade motion ffmpeg mosquitto',
    );
  });
});
