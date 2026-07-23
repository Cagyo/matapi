import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const helper = resolve(__dirname, '../../../scripts/feature-installer.py');

describe('feature installer boundary', () => {
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
seen = []; m.subprocess.run = lambda *_a, **kw: (seen.append(kw), type('R', (), {'returncode': 0})())[1]
assert m.verify_feature('digital'); assert seen and seen[0]['timeout'] == m.CHECK_TIMEOUT_SECONDS and seen[0]['shell'] is False
`;
    await expect(run('python3', ['-c', program])).resolves.toMatchObject({ stderr: '' });
  });

  it('loads privileged routines with a sudo wrapper that preserves literal argv', async () => {
    const { stdout } = await run('bash', ['-c', `
      HOME_WORKER_PRIVILEGED=1
      eval "$(sed '/^case "\\$FEATURE" in/,$d' ${JSON.stringify(resolve(__dirname, '../../../scripts/install-feature.sh'))})"
      declare -f sudo
    `]);
    expect(stdout).toContain('/usr/bin/sudo "$@"');
  });
});
