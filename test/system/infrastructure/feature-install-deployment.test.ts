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
      'live-stream-policy-inspector',
    ]) expect(install).toContain(asset);
    expect(install).toContain('sudo mv -f "$temporary" "$target"');
    expect(install).toContain('feature-install-requests /var/lib/home-worker/feature-install-results');
    expect(install).toContain('-m 0770 -o root -g "$USER"');
    expect(install).toContain('-m 0700 -o root -g root /var/lib/home-worker/feature-install-claims');
    expect(helper).toContain('0o770');
  });

  it('installs and proves the route inspection prerequisite before publishing the root bundle', () => {
    // The in-function ordering below only matters if main() reaches the function
    // at all, and only if the core apt install has already run by then.
    const mainBody = /^main\(\) \{([\s\S]*?)\n\}/m.exec(install)?.[1] ?? '';
    expect(mainBody.indexOf('install_system_deps')).toBeGreaterThanOrEqual(0);
    expect(mainBody.indexOf('install_feature_management_artifacts')).toBeGreaterThan(
      mainBody.indexOf('install_system_deps'),
    );

    const body = /install_feature_management_artifacts\(\) \{([\s\S]*?)\n\}/.exec(install)?.[1] ?? '';
    const prerequisite = body.indexOf('require_route_inspection_prerequisite');
    expect(prerequisite).toBeGreaterThanOrEqual(0);
    expect(prerequisite).toBeLessThan(body.indexOf('install_root_bundle_file'));

    // A bundle that promises the inspector on a host without /usr/sbin/ip would
    // fail every RTSP install with a misleading package reason, so the
    // prerequisite is installed and proven executable, not merely requested.
    const guard = /require_route_inspection_prerequisite\(\) \{([\s\S]*?)\n\}/.exec(install)?.[1] ?? '';
    expect(guard).toContain('iproute2');
    expect(guard).toContain('-x /usr/sbin/ip');
    expect(guard).toContain('exit 1');
  });

  it('publishes the RTSP policy inspector as a verified root-owned bundle asset', () => {
    expect(install).toContain(
      'install_root_bundle_file "$INSTALL_DIR/scripts/live-stream-policy-inspector" "$bundle/live-stream-policy-inspector" 0755',
    );
    const manifest = /\n {2}\{\n([\s\S]*?)\n {2}\} > "\$manifest_tmp"/.exec(install)?.[1] ?? '';
    expect(manifest).toContain('"$bundle/live-stream-policy-inspector"');
    expect(helper).toContain("'/usr/lib/home-worker/live-stream-policy-inspector': 0o755");
    // 0755 through the shared root installer: root-owned, never group/world writable.
    expect(install).toContain('sudo install -m "$mode" -o root -g root "$source" "$temporary"');
  });

  it('keeps the copy calls, the manifest loop, and the helper bundle map in agreement', () => {
    // Three lists describe the same bundle: install.sh's copy calls, install.sh's
    // manifest loop, and feature-installer.py's ROOT_BUNDLE_FILES. The helper map
    // stays hand-written on purpose -- it is the independent verifier -- so only
    // a test can catch drift between them. Forgetting the manifest loop alone
    // trips `len(lines) != len(ROOT_BUNDLE_FILES) + 1` and makes *every* feature
    // install on device fail as `helper-version-mismatch`, with CI fully green.
    const BUNDLE = '/usr/lib/home-worker/';

    const copied = new Map<string, number>();
    for (const [, target, mode] of install.matchAll(
      /install_root_bundle_file "[^"]+" "\$bundle\/([^"$]+)" (\d+)/g,
    )) copied.set(BUNDLE + target, Number.parseInt(mode, 8));
    const unitLoop = /for unit in ([^;]+); do\n\s*install_root_bundle_file "\$INSTALL_DIR\/systemd\/\$unit" "\$bundle\/systemd\/\$unit" (\d+)\n/.exec(install);
    expect(unitLoop, 'the systemd unit copy loop no longer has the expected shape').not.toBeNull();
    for (const unit of unitLoop![1].trim().split(/\s+/)) {
      copied.set(`${BUNDLE}systemd/${unit}`, Number.parseInt(unitLoop![2], 8));
    }

    // feature-installer.version and .manifest are deliberately absent from the
    // manifest body: the helper validates those two through VERSION_PATH and
    // MANIFEST_PATH before it walks any manifest line.
    const manifestLoop = /\n {4}for path in ([\s\S]*?); do\n/.exec(install)?.[1] ?? '';
    const manifested = [...manifestLoop.matchAll(/"\$bundle\/([^"]+)"/g)].map(([, path]) => BUNDLE + path);
    const declared = new Map<string, number>(
      [...helper.matchAll(/^ +'(\/usr\/lib\/home-worker\/[^']+)': (0o\d+),$/gm)]
        .map(([, path, mode]) => [path, Number.parseInt(mode.slice(2), 8)]),
    );

    expect(declared.size).toBeGreaterThan(0);
    expect(manifested).toHaveLength(declared.size);
    expect(new Set(manifested)).toEqual(new Set(declared.keys()));
    for (const path of manifested) expect(copied.get(path)).toBe(declared.get(path));
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
    expect(update).toContain('require_valid_feature_helper');
    expect(update).toContain('require_feature_helper_version');
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
