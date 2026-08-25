import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const helper = resolve(__dirname, '../../../scripts/feature-installer.py');

describe('feature installer boundary', () => {
  it('fails closed when the deployed helper manifest or version is stale', async () => {
    const program = String.raw`
import importlib.util, os, tempfile
spec = importlib.util.spec_from_file_location('helper', ${JSON.stringify(helper)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as root:
  m.VERSION_PATH = root + '/version'; m.MANIFEST_PATH = root + '/manifest'; m.ROOT_BUNDLE_FILES = {}
  open(m.VERSION_PATH, 'w').write('999\\n')
  open(m.MANIFEST_PATH, 'w').write('version 999\\n')
  os.chmod(m.VERSION_PATH, 0o644); os.chmod(m.MANIFEST_PATH, 0o644)
  try: m.validate_root_bundle(); raise AssertionError('stale version accepted')
  except RuntimeError as error: assert str(error) == 'helper-version-mismatch'
`;
    await expect(run('python3', ['-c', program])).resolves.toMatchObject({ stderr: '' });
  });

  it('refuses a root bundle that omits the RTSP policy inspector', async () => {
    const expectedVersion = readFileSync(
      resolve(__dirname, '../../../config/feature-installer.version'),
      'utf8',
    ).trim();
    const program = String.raw`
import importlib.util, os, tempfile
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location('helper', ${JSON.stringify(helper)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
assert m.INSTALLER_VERSION == ${JSON.stringify(expectedVersion)}, m.INSTALLER_VERSION
assert m.ROOT_BUNDLE_FILES['/usr/lib/home-worker/live-stream-policy-inspector'] == 0o755
# root_owned_file demands uid/gid 0, which this non-root test user cannot
# create, so the manifest walk below stubs it out. Prove first that the real
# check rejects a file this user owns, and that -- with ownership neutralized
# the same way the claim tests neutralize it -- the regular-file, link-count,
# and exact-mode clauses all still bite.
with tempfile.TemporaryDirectory() as probe_root:
  probe = probe_root + '/asset'
  open(probe, 'w').close(); os.chmod(probe, 0o755)
  assert m.root_owned_file(probe, 0o755) is False
  real_stat = m.os.stat
  m.os.stat = lambda path, follow_symlinks=True: (lambda v: SimpleNamespace(
    st_mode=v.st_mode, st_nlink=v.st_nlink, st_uid=0, st_gid=0))(real_stat(path, follow_symlinks=follow_symlinks))
  assert m.root_owned_file(probe, 0o755) is True
  assert m.root_owned_file(probe, 0o644) is False
  assert m.root_owned_file(probe_root, 0o700) is False
  os.link(probe, probe_root + '/hardlink')
  assert m.root_owned_file(probe, 0o755) is False
  m.os.stat = real_stat
m.root_owned_file = lambda path, mode: True
m.file_digest = lambda path: '0' * 64
with tempfile.TemporaryDirectory() as root:
  m.VERSION_PATH = root + '/version'; m.MANIFEST_PATH = root + '/manifest'
  open(m.VERSION_PATH, 'w').write(m.INSTALLER_VERSION + '\n')
  lines = ['version ' + m.INSTALLER_VERSION]
  lines += ['0' * 64 + ' ' + format(mode, '04o') + ' ' + path for path, mode in m.ROOT_BUNDLE_FILES.items()]
  open(m.MANIFEST_PATH, 'w').write('\n'.join(lines) + '\n')
  m.validate_root_bundle()
  short = [line for line in lines if not line.endswith('/live-stream-policy-inspector')]
  open(m.MANIFEST_PATH, 'w').write('\n'.join(short) + '\n')
  try: m.validate_root_bundle(); raise AssertionError('bundle without the policy inspector accepted')
  except RuntimeError as error: assert str(error) == 'helper-version-mismatch'
`;
    await expect(run('python3', ['-c', program])).resolves.toMatchObject({ stderr: '' });
  });

  it('executes strict parsers, claim durability ordering, and terminal-marker recovery', async () => {
    const program = String.raw`
import importlib.util, json, os, tempfile
spec = importlib.util.spec_from_file_location('helper', ${JSON.stringify(helper)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
request = {'version': 1, 'jobId': 'abcdefghijklmnop', 'feature': 'digital'}
assert m.parse_request(b'{"version":1,"jobId":"abcdefghijklmnop","feature":"digital"}', 'abcdefghijklmnop.json') == request
try: m.parse_request(b'{"version":1,"jobId":"abcdefghijklmnop","feature":"digital","feature":"rtsp"}', 'abcdefghijklmnop.json'); raise AssertionError('duplicate accepted')
except m.InvalidRequest: pass
bad = {'version': 1, 'jobId': request['jobId'], 'feature': 'digital', 'outcome': 'failed', 'failureCode': 'interrupted', 'privilegedReady': True, 'restartScope': None}
try: m.parse_result(json.dumps(bad).encode(), request); raise AssertionError('bad failure accepted')
except m.InvalidRequest: pass
with tempfile.TemporaryDirectory() as root:
  rq, cl = os.path.join(root, 'rq'), os.path.join(root, 'cl'); os.mkdir(rq); os.mkdir(cl)
  os.write(os.open(os.path.join(rq, 'abcdefghijklmnop.json'), os.O_WRONLY | os.O_CREAT, 0o600), m.canonical_request(request))
  rfd, cfd = os.open(rq, os.O_RDONLY), os.open(cl, os.O_RDONLY)
  calls = []; original = m.fsync_directory; m.fsync_directory = lambda fd: calls.append(fd)
  assert m.claim_next(rfd, cfd) == 'abcdefghijklmnop.json'; assert calls == [cfd, rfd]
  m.fsync_directory = original; os.close(rfd); os.close(cfd)
m.open_checked_result = lambda _fd, name, _uid, _gid: (m.canonical_request(request) if name.endswith('.running') else json.dumps({'version':1,'jobId':request['jobId'],'feature':'digital','outcome':'failed','failureCode':'interrupted','privilegedReady':False,'restartScope':None}).encode())
m.os.listdir = lambda _fd: ['abcdefghijklmnop.running']
removed = []; m.remove_entry = lambda _fd, name: removed.append(name)
m.recover_committed_markers(3, 1, 1); assert removed == ['abcdefghijklmnop.running']
seen = []; m.subprocess.run = lambda *a, **kw: (seen.append((a, kw)), type('R', (), {'returncode': 0})())[1]
assert m.verify_feature('digital'); assert seen and seen[0][1]['timeout'] == m.CHECK_TIMEOUT_SECONDS and seen[0][1]['shell'] is False
digital_argv = [' '.join(a[0]) for a, _kw in seen]
assert not any('pigpio' in c or '/pigs' in c for c in digital_argv), digital_argv
assert any('gpiodetect' in c for c in digital_argv), digital_argv
assert any('gpiomon' in c for c in digital_argv), digital_argv
`;
    await expect(run('python3', ['-c', program])).resolves.toMatchObject({ stderr: '' });
  });

  it('loads privileged routines with a sudo wrapper that preserves literal argv', async () => {
    const { stdout } = await run('bash', ['-c', `
      temp_dir="$(mktemp -d)"
      export temp_dir
      trap 'rm -rf "$temp_dir"' EXIT
      printf '#!/bin/sh\\nprintf "%%s " "$@" > "${'${temp_dir}'}/argv"\\n' > "$temp_dir/sudo"
      chmod 700 "$temp_dir/sudo"
      HOME_WORKER_PRIVILEGED=1
      eval "$(sed '/^case "\\$FEATURE" in/,$d' ${JSON.stringify(resolve(__dirname, '../../../scripts/install-feature.sh'))} | sed "s|/usr/bin/sudo|$temp_dir/sudo|g")"
      sudo -H -u homeworker /bin/true
      cat "$temp_dir/argv"
    `]);
    expect(stdout).toBe('-H -u homeworker /bin/true ');
  });

  it('executes the claim-to-terminal path with patched fixed layout seams and kills timed-out routine groups', async () => {
    const program = String.raw`
import importlib.util, json, os, stat, tempfile
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location('helper', ${JSON.stringify(helper)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
request = {'version': 1, 'jobId': 'abcdefghijklmnop', 'feature': 'digital'}
with tempfile.TemporaryDirectory() as root:
  m.INSTALL_ROOT = root; m.REQUEST_DIRECTORY = root + '/requests'; m.CLAIM_DIRECTORY = root + '/claims'; m.RESULT_DIRECTORY = root + '/results'
  for path in (m.REQUEST_DIRECTORY, m.CLAIM_DIRECTORY, m.RESULT_DIRECTORY): os.mkdir(path)
  os.write(os.open(m.REQUEST_DIRECTORY + '/abcdefghijklmnop.json', os.O_WRONLY | os.O_CREAT, 0o600), m.canonical_request(request))
  uid, gid = os.getuid(), os.getgid(); m.worker_ids = lambda: (uid, gid); m.validate_layout = lambda *_: None; m.validate_root_bundle = lambda: None
  m.directory_fd = lambda path, *_: os.open(path, os.O_RDONLY)
  real_open_claim, real_fchown = m.open_claim, m.os.fchown
  m.open_claim = lambda *_: m.canonical_request(request); m.os.fchown = lambda *_: None
  real_run_routine = m.run_routine; m.run_routine = lambda _: 'ok'; m.verify_feature = lambda _: True
  assert m.process_one() is True
  assert not os.path.exists(m.REQUEST_DIRECTORY + '/abcdefghijklmnop.json')
  assert not os.path.exists(m.CLAIM_DIRECTORY + '/abcdefghijklmnop.json')
  result = json.load(open(m.RESULT_DIRECTORY + '/abcdefghijklmnop.json')); assert result['outcome'] == 'succeeded'
  # The real descriptor validator rejects links, special files, bad modes, and oversized claims.
  m.open_claim, m.os.fchown, m.run_routine = real_open_claim, real_fchown, real_run_routine
  claim = m.CLAIM_DIRECTORY + '/abcdefghijklmnop.json'; open(claim, 'wb').write(m.canonical_request(request)); os.chmod(claim, 0o600)
  original_fstat, original_fchown = m.os.fstat, m.os.fchown; normalized = {'done': False}
  def fake_fstat(fd):
    value = original_fstat(fd)
    return SimpleNamespace(st_mode=value.st_mode, st_nlink=value.st_nlink, st_size=value.st_size, st_uid=0 if normalized['done'] else uid, st_gid=0 if normalized['done'] else gid)
  m.os.fstat = fake_fstat; m.os.fchown = lambda *_: normalized.__setitem__('done', True)
  fd = os.open(m.CLAIM_DIRECTORY, os.O_RDONLY); assert m.open_claim(fd, 'abcdefghijklmnop.json', uid, gid) == m.canonical_request(request); os.close(fd); assert normalized['done']
  m.os.fstat, m.os.fchown = original_fstat, original_fchown
  for mode, content in ((0o644, b'x'), (0o600, b'x' * 4097)):
    open(claim, 'wb').write(content); os.chmod(claim, mode); fd = os.open(m.CLAIM_DIRECTORY, os.O_RDONLY)
    try: m.open_claim(fd, 'abcdefghijklmnop.json', uid, gid); raise AssertionError('unsafe claim accepted')
    except m.InvalidRequest: pass
    finally: os.close(fd)
  os.unlink(claim); os.mkfifo(claim, 0o600); fd = os.open(m.CLAIM_DIRECTORY, os.O_RDONLY)
  try: m.open_claim(fd, 'abcdefghijklmnop.json', uid, gid); raise AssertionError('FIFO accepted')
  except m.InvalidRequest: pass
  finally: os.close(fd); os.unlink(claim)
  target = m.CLAIM_DIRECTORY + '/target'; open(target, 'wb').write(b'x'); os.symlink(target, claim); fd = os.open(m.CLAIM_DIRECTORY, os.O_RDONLY)
  try: m.open_claim(fd, 'abcdefghijklmnop.json', uid, gid); raise AssertionError('symlink accepted')
  except OSError: pass
  finally: os.close(fd); os.unlink(claim)
  class Timed:
    pid = 91
    def wait(self, timeout=None):
      if timeout is not None: raise m.subprocess.TimeoutExpired('routine', timeout)
      return 0
  seen, killed = {}, []
  m.subprocess.Popen = lambda argv, **kw: (seen.update(argv=argv, kw=kw), Timed())[1]
  m.os.killpg = lambda pid, sig: killed.append((pid, sig))
  assert m.run_routine('digital') == 'interrupted'; assert seen['argv'] == [m.ROUTINES_PATH, 'digital'] and seen['kw']['shell'] is False and seen['kw']['start_new_session'] is True and killed == [(91, m.signal.SIGKILL)]
`;
    await expect(run('python3', ['-c', program])).resolves.toMatchObject({ stderr: '' });
  });
});
