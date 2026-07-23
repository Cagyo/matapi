import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const install = readFileSync(resolve('scripts/install.sh'), 'utf8');
const update = readFileSync(resolve('scripts/update.sh'), 'utf8');
const helper = readFileSync(resolve('scripts/feature-installer.py'), 'utf8');

describe('feature-management deployment boundary', () => {
  it('deploys all root bundle assets atomically with usable spool permissions', () => {
    for (const asset of [
      'feature-installer.py', 'install-feature.sh', 'live-stream-net-helper', 'live-stream-ffmpeg-runner',
      'homeworker-feature-install.service', 'homeworker-feature-supervisor-restart.service',
      'homeworker-feature-host-reboot.service', 'homeworker-ffmpeg-stream@.service',
      'homeworker-stream-net.service', 'homeworker-stream-systemd.rules',
    ]) expect(install).toContain(asset);
    expect(install).toContain('sudo mv -f "$temporary" "$target"');
    expect(install).toContain('feature-install-requests /var/lib/home-worker/feature-install-results');
    expect(install).toContain('-m 0770 -o root -g "$USER"');
    expect(install).toContain('-m 0700 -o root -g root /var/lib/home-worker/feature-install-claims');
    expect(helper).toContain('0o770');
  });

  it('grants only the three fixed no-block feature starts through the new sudoers file', () => {
    const match = /install_feature_management_sudoers\(\) \{([\s\S]*?)\n\}/.exec(install)?.[1] ?? '';
    expect(match).toContain('/bin/systemctl start --no-block homeworker-feature-install.service');
    expect(match).toContain('/bin/systemctl start --no-block homeworker-feature-supervisor-restart.service');
    expect(match).toContain('/bin/systemctl start --no-block homeworker-feature-host-reboot.service');
    expect(match).not.toContain('daemon-reload');
  });

  it('keeps an unprivileged updater fail-closed and free of root artifact installation', () => {
    expect(update).toContain('helper-update-required');
    expect(update).toContain('require_current_feature_helper');
    expect(update).not.toMatch(/sudo\s+(?:install|mv|chown|systemctl\s+daemon-reload)/);
  });

  it('requires an exact root-owned manifest and version before routine work', () => {
    expect(helper).toContain('validate_root_bundle()');
    expect(helper).toContain('helper-version-mismatch');
    expect(helper).toContain('--validate-installation');
    expect(helper).toContain('--verify-feature');
  });

  it('uses the fixed worker config while loading root-owned RTSP templates', () => {
    const routines = readFileSync(resolve('scripts/install-feature.sh'), 'utf8');
    expect(routines).toContain('INSTALL_DIR="/opt/home-worker"');
    expect(routines).toContain('ROOT_BUNDLE_DIR="/usr/lib/home-worker"');
    expect(routines).toContain('$ROOT_BUNDLE_DIR/systemd/homeworker-stream-net.service');
    expect(routines).not.toContain('$INSTALL_DIR/systemd/homeworker-stream-net.service');
  });
});
