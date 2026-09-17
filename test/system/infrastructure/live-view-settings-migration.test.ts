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
  events, paths = [], {}
  real_open, real_fsync, real_replace = m.os.open, m.os.fsync, m.os.replace
  def traced_open(path, *args, **kwargs):
    descriptor = real_open(path, *args, **kwargs)
    paths[descriptor] = path
    return descriptor
  def traced_fsync(fd):
    label = paths.get(fd, '')
    events.append('dir-fsync:' + os.path.basename(label) if stat.S_ISDIR(os.fstat(fd).st_mode) else 'file-fsync:' + os.path.basename(label))
    return real_fsync(fd)
  def traced_replace(source, target, **kwargs):
    events.append('replace:' + os.path.basename(target))
    return real_replace(source, target, **kwargs)
  m.os.open, m.os.fsync, m.os.replace = traced_open, traced_fsync, traced_replace
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
    assert events[replace - 1].startswith('file-fsync:.' + name + '.'), events
    assert events[replace + 1] == 'dir-fsync:' + os.path.basename(root), events
`;

    await expect(run("python3", ["-c", program])).resolves.toMatchObject({
      stderr: "",
    });
  });

  it("fails legacy input closed and resumes cleanly after a marker-before-settings crash", async () => {
    const program = String.raw`
import importlib.util, json, os, tempfile
spec = importlib.util.spec_from_file_location('helper', ${JSON.stringify(helper)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

def configure(root, body):
  m.INSTALL_ROOT = root
  m.WORKER_ENV_PATH = root + '/worker.env'
  m.LIVE_VIEW_SETTINGS_PATH = root + '/live-view-settings.json'
  m.LIVE_VIEW_ATTENTION_PATH = root + '/live-view-settings-migration-attention.json'
  m.ROOT_UID = os.getuid(); m.ROOT_GID = os.getgid()
  m.worker_ids = lambda: (os.getuid(), os.getgid())
  with open(m.WORKER_ENV_PATH, 'wb') as stream: stream.write(body)
  os.chmod(m.WORKER_ENV_PATH, 0o600)

for body, unsafe_kind in (
  (b'LIVE_STREAM_ENABLED=true\nLIVE_STREAM_ENABLED=false\n', 'duplicate'),
  (b'X=' + b'x' * (m.MAX_ENV_BYTES + 1), 'oversized'),
):
  with tempfile.TemporaryDirectory() as root:
    configure(root, body)
    migrated = m.migrate_live_view_settings()
    assert migrated['attention'] == 'legacy-values-invalid', unsafe_kind
    assert json.load(open(m.LIVE_VIEW_SETTINGS_PATH)) == {
      'version': 1, 'generation': 0, 'enabled': False, 'allowedCameraCidrs': []}
    assert open(m.LIVE_VIEW_ATTENTION_PATH, 'rb').read() == b'{"version":1,"code":"legacy-values-invalid"}\n'

for unsafe_kind in ('mode', 'hardlink', 'symlink'):
  with tempfile.TemporaryDirectory() as root:
    configure(root, b'LIVE_STREAM_ENABLED=true\nRTSP_ALLOWED_CIDRS=10.0.0.0/8\n')
    if unsafe_kind == 'mode':
      os.chmod(m.WORKER_ENV_PATH, 0o644)
    elif unsafe_kind == 'hardlink':
      os.link(m.WORKER_ENV_PATH, root + '/worker.env.link')
    else:
      target = root + '/target.env'; os.rename(m.WORKER_ENV_PATH, target); os.symlink(target, m.WORKER_ENV_PATH)
    migrated = m.migrate_live_view_settings()
    assert migrated['attention'] == 'legacy-values-invalid', unsafe_kind
    assert json.load(open(m.LIVE_VIEW_SETTINGS_PATH))['enabled'] is False

class Crash(BaseException):
  pass

with tempfile.TemporaryDirectory() as root:
  configure(root, b'LIVE_STREAM_ENABLED=true\nRTSP_ALLOWED_CIDRS=not-a-cidr\n')
  real_write = m._atomic_path_write
  def crash_after_marker(path, *args, **kwargs):
    real_write(path, *args, **kwargs)
    if path == m.LIVE_VIEW_ATTENTION_PATH:
      raise Crash()
  m._atomic_path_write = crash_after_marker
  try:
    m.migrate_live_view_settings()
    raise AssertionError('marker-before-settings crash was swallowed')
  except Crash:
    pass
  assert os.path.exists(m.LIVE_VIEW_ATTENTION_PATH)
  assert not os.path.exists(m.LIVE_VIEW_SETTINGS_PATH)
  assert not [name for name in os.listdir(root) if name.endswith('.tmp')]

  with open(m.WORKER_ENV_PATH, 'wb') as stream:
    stream.write(b'LIVE_STREAM_ENABLED=true\nRTSP_ALLOWED_CIDRS=192.168.1.42/24\n')
  os.chmod(m.WORKER_ENV_PATH, 0o600)
  m._atomic_path_write = real_write
  migrated = m.migrate_live_view_settings()
  assert migrated['attention'] is None
  assert json.load(open(m.LIVE_VIEW_SETTINGS_PATH)) == {
    'version': 1, 'generation': 0, 'enabled': True,
    'allowedCameraCidrs': ['192.168.1.0/24']}
  assert not os.path.exists(m.LIVE_VIEW_ATTENTION_PATH)
  assert not [name for name in os.listdir(root) if name.endswith('.tmp')]
`;
    await expect(run("python3", ["-c", program])).resolves.toMatchObject({
      stdout: "",
      stderr: "",
    });
  });

  it("preserves an existing typed authority and refuses unsafe repair", async () => {
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

`;

    await expect(run("python3", ["-c", program])).resolves.toMatchObject({
      stderr: "",
    });
  });

  it("delegates reset as one bounded applier process and kills the full group on timeout", async () => {
    const program = String.raw`
import importlib.util, os
spec = importlib.util.spec_from_file_location('helper', ${JSON.stringify(helper)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

seen = {}
real_popen, real_killpg = m.subprocess.Popen, m.os.killpg
class Completed:
  pid = 41
  def wait(self, timeout=None):
    seen.setdefault('waits', []).append(timeout)
    return 0
def complete(argv, **kwargs):
  seen['argv'] = argv; seen['kwargs'] = kwargs
  return Completed()
m.subprocess.Popen = complete
m.run_live_view_reset()
assert seen['argv'] == [m.LIVE_VIEW_APPLIER_PATH, '--reset-live-view-settings']
assert seen['kwargs'] == {
  'cwd': '/', 'env': m.SAFE_ENV, 'shell': False,
  'stdin': m.subprocess.DEVNULL, 'stdout': m.subprocess.DEVNULL,
  'stderr': m.subprocess.DEVNULL, 'start_new_session': True,
}
assert seen['waits'] == [m.LIVE_VIEW_RESET_TIMEOUT_SECONDS]
assert m.LIVE_VIEW_RESET_TIMEOUT_SECONDS > 60

killed, waits = [], []
class Timed:
  pid = 73
  def wait(self, timeout=None):
    waits.append(timeout)
    if len(waits) == 1:
      raise m.subprocess.TimeoutExpired('reset', timeout)
    return -9
m.subprocess.Popen = lambda *args, **kwargs: Timed()
m.os.killpg = lambda pid, value: killed.append((pid, value))
try:
  m.run_live_view_reset()
  raise AssertionError('timed-out reset reported success')
except RuntimeError as error:
  assert str(error) == 'policy-reset-failed'
assert killed == [(73, m.signal.SIGKILL)]
assert waits == [m.LIVE_VIEW_RESET_TIMEOUT_SECONDS, None]

m.LIVE_VIEW_APPLIER_PATH = '/usr/bin/yes'
m.LIVE_VIEW_RESET_TIMEOUT_SECONDS = 0.2
pids = []
def recording_popen(*args, **kwargs):
  process = real_popen(*args, **kwargs)
  pids.append(process.pid)
  return process
m.subprocess.Popen, m.os.killpg = recording_popen, real_killpg
try:
  m.run_live_view_reset()
  raise AssertionError('slow reset reported success')
except RuntimeError as error:
  assert str(error) == 'policy-reset-failed'
assert len(pids) == 1
try:
  os.kill(pids[0], 0)
  raise AssertionError('timed-out reset leader survived')
except ProcessLookupError:
  pass

calls = []
m.sys.argv = ['feature-installer', '--reset-live-view-settings']
m.validate_root_bundle = lambda: calls.append('bundle')
m.run_live_view_reset = lambda: calls.append('reset')
m.migrate_live_view_settings = lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError('reset wrote settings outside applier'))
assert m.main() == 0
assert calls == ['bundle', 'reset']
`;
    await expect(run("python3", ["-c", program])).resolves.toMatchObject({
      stdout: "",
      stderr: "",
    });
  });
});
