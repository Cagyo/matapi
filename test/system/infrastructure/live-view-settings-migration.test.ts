import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const helper = resolve(__dirname, "../../../scripts/feature-installer.py");

describe("live-view settings generation-zero migration", () => {
  it("maps only strict legacy values into canonical generation-zero settings", async () => {
    const program = String.raw`
import importlib.util, json
spec = importlib.util.spec_from_file_location('helper', ${JSON.stringify(helper)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
cases = [
  ({}, {'settings': {'version': 1, 'generation': 0, 'enabled': False, 'allowedCameraCidrs': []}, 'attention': None}),
  ({'LIVE_STREAM_ENABLED': 'true', 'RTSP_ALLOWED_CIDRS': '192.168.1.42/24'},
   {'settings': {'version': 1, 'generation': 0, 'enabled': True, 'allowedCameraCidrs': ['192.168.1.0/24']}, 'attention': None}),
  ({'LIVE_STREAM_ENABLED': 'false', 'RTSP_ALLOWED_CIDRS': 'fd12:3456:789a::1/64, 10.2.3.4/8'},
   {'settings': {'version': 1, 'generation': 0, 'enabled': False, 'allowedCameraCidrs': ['10.0.0.0/8', 'fd12:3456:789a::/64']}, 'attention': None}),
  ({'LIVE_STREAM_ENABLED': 'yes', 'RTSP_ALLOWED_CIDRS': '192.168.1.0/24'},
   {'settings': {'version': 1, 'generation': 0, 'enabled': False, 'allowedCameraCidrs': []}, 'attention': 'legacy-values-invalid'}),
  ({'LIVE_STREAM_ENABLED': 'true', 'RTSP_ALLOWED_CIDRS': 'not-a-cidr'},
   {'settings': {'version': 1, 'generation': 0, 'enabled': False, 'allowedCameraCidrs': []}, 'attention': 'legacy-values-invalid'}),
]
for legacy, expected in cases:
  assert m.legacy_live_view_settings(legacy) == expected, (legacy.keys(), m.legacy_live_view_settings(legacy))
`;

    await expect(run("python3", ["-c", program])).resolves.toMatchObject({
      stderr: "",
    });
  });

  it("publishes the settings and bounded attention marker durably with exact metadata", async () => {
    const program = String.raw`
import importlib.util, json, os, stat, tempfile
spec = importlib.util.spec_from_file_location('helper', ${JSON.stringify(helper)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as root:
  m.INSTALL_ROOT = root
  m.WORKER_ENV_PATH = root + '/worker.env'
  m.LIVE_VIEW_SETTINGS_PATH = root + '/live-view-settings.json'
  m.LIVE_VIEW_ATTENTION_PATH = root + '/live-view-settings-migration-attention.json'
  m.ROOT_UID = os.getuid(); m.ROOT_GID = os.getgid()
  m.worker_ids = lambda: (os.getuid(), os.getgid())
  open(m.WORKER_ENV_PATH, 'w').write('LIVE_STREAM_ENABLED=true\nRTSP_ALLOWED_CIDRS=not-a-cidr\n')
  os.chmod(m.WORKER_ENV_PATH, 0o600)
  events = []
  real_fsync, real_replace = m.os.fsync, m.os.replace
  def traced_fsync(fd):
    events.append('dir-fsync' if stat.S_ISDIR(os.fstat(fd).st_mode) else 'file-fsync')
    return real_fsync(fd)
  def traced_replace(source, target, **kwargs):
    events.append('replace:' + os.path.basename(target))
    return real_replace(source, target, **kwargs)
  m.os.fsync, m.os.replace = traced_fsync, traced_replace
  result = m.migrate_live_view_settings()
  assert result['attention'] == 'legacy-values-invalid'
  expected = {'version': 1, 'generation': 0, 'enabled': False, 'allowedCameraCidrs': []}
  assert json.load(open(m.LIVE_VIEW_SETTINGS_PATH)) == expected
  assert open(m.LIVE_VIEW_ATTENTION_PATH, 'rb').read() == b'{"version":1,"code":"legacy-values-invalid"}\n'
  for path in (m.LIVE_VIEW_SETTINGS_PATH, m.LIVE_VIEW_ATTENTION_PATH):
    info = os.stat(path, follow_symlinks=False)
    assert stat.S_ISREG(info.st_mode) and info.st_nlink == 1
    assert info.st_uid == os.getuid() and info.st_gid == os.getgid()
    assert stat.S_IMODE(info.st_mode) == 0o640
  for name in ('live-view-settings-migration-attention.json', 'live-view-settings.json'):
    replace = events.index('replace:' + name)
    assert 'file-fsync' in events[:replace], events
    assert 'dir-fsync' in events[replace + 1:], events
`;

    await expect(run("python3", ["-c", program])).resolves.toMatchObject({
      stderr: "",
    });
  });

  it("preserves an existing typed authority, refuses unsafe repair, and resets only explicitly", async () => {
    const program = String.raw`
import importlib.util, json, os, stat, tempfile
spec = importlib.util.spec_from_file_location('helper', ${JSON.stringify(helper)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as root:
  m.INSTALL_ROOT = root
  m.WORKER_ENV_PATH = root + '/worker.env'
  m.LIVE_VIEW_SETTINGS_PATH = root + '/live-view-settings.json'
  m.LIVE_VIEW_ATTENTION_PATH = root + '/live-view-settings-migration-attention.json'
  m.ROOT_UID = os.getuid(); m.ROOT_GID = os.getgid()
  m.worker_ids = lambda: (os.getuid(), os.getgid())
  open(m.WORKER_ENV_PATH, 'w').write('LIVE_STREAM_ENABLED=false\nRTSP_ALLOWED_CIDRS=10.0.0.0/8\n')
  os.chmod(m.WORKER_ENV_PATH, 0o600)
  existing = b'{"version":1,"generation":9,"enabled":true,"allowedCameraCidrs":["192.168.0.0/16"]}\n'
  open(m.LIVE_VIEW_SETTINGS_PATH, 'wb').write(existing); os.chmod(m.LIVE_VIEW_SETTINGS_PATH, 0o640)
  assert m.migrate_live_view_settings()['status'] == 'preserved'
  assert open(m.LIVE_VIEW_SETTINGS_PATH, 'rb').read() == existing

  unsafe = b'{"version":1,"generation":77,"enabled":true,"allowedCameraCidrs":["10.0.0.0/8"]}\n'
  open(m.LIVE_VIEW_SETTINGS_PATH, 'wb').write(unsafe); os.chmod(m.LIVE_VIEW_SETTINGS_PATH, 0o666)
  try:
    m.migrate_live_view_settings()
    raise AssertionError('unsafe authority was silently reset')
  except RuntimeError as error:
    assert str(error) == 'settings-state-unsafe'
  assert open(m.LIVE_VIEW_SETTINGS_PATH, 'rb').read() == unsafe
  assert stat.S_IMODE(os.stat(m.LIVE_VIEW_SETTINGS_PATH).st_mode) == 0o666

  open(m.LIVE_VIEW_ATTENTION_PATH, 'wb').write(b'{"version":1,"code":"legacy-values-invalid"}\n')
  os.chmod(m.LIVE_VIEW_ATTENTION_PATH, 0o640)
  bootstraps = []
  def bootstrap():
    value = json.load(open(m.LIVE_VIEW_SETTINGS_PATH))
    assert value == {'version': 1, 'generation': 0, 'enabled': False, 'allowedCameraCidrs': []}
    bootstraps.append(value)
  m.run_live_view_bootstrap = bootstrap
  reset = m.migrate_live_view_settings(reset=True)
  assert reset['status'] == 'reset' and len(bootstraps) == 1
  assert not os.path.exists(m.LIVE_VIEW_ATTENTION_PATH)
  assert stat.S_IMODE(os.stat(m.LIVE_VIEW_SETTINGS_PATH).st_mode) == 0o640
`;

    await expect(run("python3", ["-c", program])).resolves.toMatchObject({
      stderr: "",
    });
  });
});
