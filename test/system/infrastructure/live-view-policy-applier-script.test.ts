import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const applier = resolve(
  __dirname,
  "../../../scripts/live-view-policy-applier.py",
);
const unit = resolve(
  __dirname,
  "../../../systemd/homeworker-live-view-policy-apply.service",
);

const prelude = String.raw`
import importlib.util, json, os, stat, tempfile
from pathlib import Path
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('live_view_policy_applier', ${JSON.stringify(applier)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
real_rtsp_assets_state = m.rtsp_assets_state

REQUEST_ID = 'AbCdEfGhIjKlMnOp'
SECOND_ID = 'PqRsTuVwXyZaBcDe'


def bytes_for(value):
    return (json.dumps(value, separators=(',', ':'), sort_keys=True) + '\n').encode('utf-8')


def write_file(path, body, mode):
    with open(path, 'wb') as stream:
        stream.write(body)
    os.chmod(path, mode)


def settings(generation=3, enabled=False, cidrs=None):
    return {
        'version': 1,
        'generation': generation,
        'enabled': enabled,
        'allowedCameraCidrs': [] if cidrs is None else cidrs,
    }


def settings_request(request_id=REQUEST_ID, expected=3, enabled=True, cidrs=None, rtsp=True):
    return {
        'version': 1,
        'kind': 'settings-mutation',
        'requestId': request_id,
        'expectedGeneration': expected,
        'rtspEnabled': rtsp,
        'settings': {
            'enabled': enabled,
            'allowedCameraCidrs': ['192.168.1.0/24'] if cidrs is None else cidrs,
        },
    }


def reconcile_request(request_id=SECOND_ID, expected=4, rtsp=False):
    return {
        'version': 1,
        'kind': 'rtsp-state-reconcile',
        'requestId': request_id,
        'expectedGeneration': expected,
        'rtspEnabled': rtsp,
    }


def configure(root, initial=None, assets=True):
    os.chmod(root, 0o711)
    m.ROOT_UID = os.getuid()
    m.ROOT_GID = os.getgid()
    m.INSTALL_ROOT = root
    m.SETTINGS_PATH = os.path.join(root, 'live-view-settings.json')
    m.ATTENTION_PATH = os.path.join(root, 'live-view-settings-migration-attention.json')
    m.REQUEST_DIRECTORY = os.path.join(root, 'requests')
    m.CLAIM_DIRECTORY = os.path.join(root, 'claims')
    m.RESULT_DIRECTORY = os.path.join(root, 'results')
    m.ACK_DIRECTORY = os.path.join(root, 'acks')
    m.POLICY_DIRECTORY = os.path.join(root, 'policy')
    m.POLICY_PATH = os.path.join(m.POLICY_DIRECTORY, 'live-stream-policy.json')
    m.LOCK_PATH = os.path.join(root, 'live-view-policy.lock')
    for path, mode in (
        (m.REQUEST_DIRECTORY, 0o770),
        (m.CLAIM_DIRECTORY, 0o700),
        (m.RESULT_DIRECTORY, 0o750),
        (m.ACK_DIRECTORY, 0o770),
        (m.POLICY_DIRECTORY, 0o755),
    ):
        os.mkdir(path)
        os.chmod(path, mode)
    write_file(m.SETTINGS_PATH, bytes_for(initial or settings()), 0o640)
    m.worker_ids = lambda: (os.getuid(), os.getgid())
    m.policy_runtime_values = lambda: (501, 997, 24000, 24001)
    # The test account owns both fixture sides. Production uses distinct root
    # and worker owners, so tests opt into replay only after an injected crash.
    m.claim_replay_state = lambda _metadata, _uid, _gid: False
    # macOS exposes tempfile paths through /var, which is itself a symlink.
    # Production parent-walk coverage is kept separate from this disposable tree.
    m.validate_parent_chain = lambda _path: None
    m.validate_fixed_parents = lambda: None
    m.validate_root_bundle = lambda: None
    m.rtsp_assets_state = lambda: 'valid' if assets else 'absent'
    m.activate_policy = lambda _policy: None
    return root


def publish(value):
    path = os.path.join(m.REQUEST_DIRECTORY, value['requestId'] + '.json')
    write_file(path, bytes_for(value), 0o600)
    return path


def result(request_id):
    with open(os.path.join(m.RESULT_DIRECTORY, request_id + '.json'), 'r', encoding='utf-8') as stream:
        return json.load(stream)
`;

async function execute(body: string): Promise<void> {
  await expect(
    run("python3", ["-c", `${prelude}\n${body}`], { maxBuffer: 1024 * 1024 }),
  ).resolves.toMatchObject({ stderr: "" });
}

describe("live view root policy applier", () => {
  it("runs through the fixed root-only hardened oneshot unit", () => {
    expect(readFileSync(unit, "utf8")).toBe(`[Unit]
Description=Home Worker live view policy applier
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/lib/home-worker/live-view-policy-applier
TimeoutStartSec=60
User=root
Group=root
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
ProtectControlGroups=yes
ProtectKernelModules=yes
ProtectKernelTunables=yes
RestrictRealtime=yes
StandardOutput=journal
StandardError=journal
`);
  });

  it("parses only bounded duplicate-free requests and canonicalizes private CIDRs", async () => {
    await execute(String.raw`
value = settings_request(cidrs=['192.168.1.42/24', '10.0.0.0/8', '192.168.1.0/24'])
parsed = m.parse_request(bytes_for(value), REQUEST_ID + '.json')
assert parsed['settings']['allowedCameraCidrs'] == ['10.0.0.0/8', '192.168.1.0/24'], parsed
try:
    m.parse_request(
        b'{"version":1,"kind":"rtsp-state-reconcile","requestId":"AbCdEfGhIjKlMnOp","expectedGeneration":3,"rtspEnabled":true,"rtspEnabled":false}',
        REQUEST_ID + '.json',
    )
    raise AssertionError('duplicate key accepted')
except m.InvalidRequest:
    pass
try:
    m.parse_request(b'x' * 4097, REQUEST_ID + '.json')
    raise AssertionError('oversized request accepted')
except m.InvalidRequest:
    pass
try:
    nested = b'[' * 1100 + b'0' + b']' * 1100
    m.parse_request(nested, REQUEST_ID + '.json')
    raise AssertionError('pathologically nested request accepted')
except m.InvalidRequest:
    pass
try:
    m.parse_request(bytes_for({**value, 'command': '/bin/sh'}), REQUEST_ID + '.json')
    raise AssertionError('caller command accepted')
except m.InvalidRequest:
    pass
try:
    m.parse_policy(bytes_for({
        'version': 2,
        'settingsGeneration': 4,
        'rtspEnabled': False,
        'workerUid': 501,
        'streamUid': 997,
        'allowedCidrs': ['192.168.1.0/24'],
        'udpPortFirst': 24000,
        'udpPortLast': 24001,
    }))
    raise AssertionError('disabled policy retained grants')
except m.InvalidRequest:
    pass
`);
  });

  it("claims by durable cross-directory rename and rejects unsafe claim metadata", async () => {
    await execute(String.raw`
with tempfile.TemporaryDirectory() as root:
    configure(root)
    publish(settings_request())
    request_fd = m.directory_fd(m.REQUEST_DIRECTORY, m.ROOT_UID, os.getgid(), 0o770)
    claim_fd = m.directory_fd(m.CLAIM_DIRECTORY, m.ROOT_UID, m.ROOT_GID, 0o700)
    calls = []
    original_sync = m.fsync_directory
    m.fsync_directory = lambda fd: calls.append(fd)
    assert m.claim_next(request_fd, claim_fd) == REQUEST_ID + '.json'
    assert calls == [claim_fd, request_fd], calls
    m.fsync_directory = original_sync
    claim = os.path.join(m.CLAIM_DIRECTORY, REQUEST_ID + '.json')
    worker_inode = os.stat(claim).st_ino
    normalizations = []
    original_chown = m.os.fchown
    m.os.fchown = lambda fd, uid, gid: (
        normalizations.append((uid, gid)),
        original_chown(fd, uid, gid),
    )[1]
    claim_data, replay = m.open_claim(
        claim_fd, REQUEST_ID + '.json', os.getuid(), os.getgid()
    )
    assert claim_data == bytes_for(settings_request())
    assert replay is False
    assert normalizations == []
    request = m.parse_request(claim_data, REQUEST_ID + '.json')
    m.seal_claim(claim_fd, REQUEST_ID + '.json', request)
    assert normalizations == [(m.ROOT_UID, m.ROOT_GID)]
    assert os.stat(claim).st_ino != worker_inode
    assert Path(claim).read_bytes() == bytes_for(request)
    m.os.fchown = original_chown
    os.chmod(claim, 0o640)
    try:
        m.open_claim(claim_fd, REQUEST_ID + '.json', os.getuid(), os.getgid())
        raise AssertionError('wrong claim mode accepted')
    except m.InvalidRequest:
        pass
    os.chmod(claim, 0o600)
    os.link(claim, claim + '.linked')
    try:
        m.open_claim(claim_fd, REQUEST_ID + '.json', os.getuid(), os.getgid())
        raise AssertionError('multi-link claim accepted')
    except m.InvalidRequest:
        pass
    os.unlink(claim + '.linked')
    os.unlink(claim)
    os.symlink('/dev/null', claim)
    try:
        m.open_claim(claim_fd, REQUEST_ID + '.json', os.getuid(), os.getgid())
        raise AssertionError('symlink claim accepted')
    except m.InvalidRequest:
        pass
    os.close(request_fd)
    os.close(claim_fd)
`);
  });

  it("fsyncs staged files before rename and their parent after rename", async () => {
    await execute(String.raw`
with tempfile.TemporaryDirectory() as root:
    os.chmod(root, 0o700)
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    events = []
    original_sync = m.os.fsync
    original_replace = m.os.replace
    m.os.fsync = lambda fd: (
        events.append('directory' if stat.S_ISDIR(os.fstat(fd).st_mode) else 'file'),
        original_sync(fd),
    )[1]
    m.os.replace = lambda *args, **kwargs: (
        events.append('rename'),
        original_replace(*args, **kwargs),
    )[1]
    m.write_atomic(directory, 'authority.json', b'{}\n', os.getuid(), os.getgid(), 0o640)
    assert events == ['file', 'rename', 'directory'], events
    assert Path(root, 'authority.json').read_bytes() == b'{}\n'

    m.os.replace = lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError('injected'))
    try:
        m.write_atomic(directory, 'failed.json', b'{}\n', os.getuid(), os.getgid(), 0o640)
        raise AssertionError('injected rename failure accepted')
    except OSError:
        pass
    assert not [name for name in os.listdir(root) if name.startswith('.failed.json.')]
    os.close(directory)
`);
  });

  it("fails closed before claiming from an incorrectly permissioned spool", async () => {
    await execute(String.raw`
with tempfile.TemporaryDirectory() as root:
    configure(root)
    request_path = publish(settings_request())
    os.chmod(m.REQUEST_DIRECTORY, 0o750)
    try:
        m.process_one()
        raise AssertionError('unsafe request directory accepted')
    except RuntimeError:
        pass
    assert os.path.exists(request_path)
    assert not os.path.exists(os.path.join(m.RESULT_DIRECTORY, REQUEST_ID + '.json'))
    assert not os.path.exists(m.POLICY_PATH)

with tempfile.TemporaryDirectory() as root:
    configure(root)
    os.chmod(root, 0o700)
    try:
        worker_uid, worker_gid = m.worker_ids()
        m.validate_layout(worker_uid, worker_gid)
        raise AssertionError('install root mode other than 0711 accepted')
    except RuntimeError:
        pass
`);
  });

  it("quarantines a non-regular claim so a later valid request can progress", async () => {
    await execute(String.raw`
with tempfile.TemporaryDirectory() as root:
    configure(root, settings(generation=3, enabled=False), assets=False)
    unsafe_name = REQUEST_ID + '.json'
    os.mkdir(os.path.join(m.REQUEST_DIRECTORY, unsafe_name), 0o600)
    publish(settings_request(request_id=SECOND_ID))

    assert m.process_one() is True
    assert not os.path.exists(os.path.join(m.CLAIM_DIRECTORY, unsafe_name))
    quarantined = [
        name for name in os.listdir(m.CLAIM_DIRECTORY)
        if name.startswith('.unsafe-')
    ]
    assert len(quarantined) == 1, quarantined
    assert os.path.isdir(os.path.join(m.CLAIM_DIRECTORY, quarantined[0]))
    assert not os.path.exists(os.path.join(m.RESULT_DIRECTORY, REQUEST_ID + '.json'))

    assert m.process_one() is True
    assert result(SECOND_ID)['outcome'] == 'succeeded'
    assert result(SECOND_ID)['resultingGeneration'] == 4
    assert json.loads(Path(m.SETTINGS_PATH).read_text())['generation'] == 4
`);
  });

  it("commits policy and service before settings and removes one valid legacy marker", async () => {
    await execute(String.raw`
with tempfile.TemporaryDirectory() as root:
    configure(root, settings(generation=3, enabled=False))
    write_file(
        m.ATTENTION_PATH,
        b'{"version":1,"code":"legacy-values-invalid"}\n',
        0o640,
    )
    publish(settings_request(cidrs=['192.168.1.42/24', '10.0.0.0/8']))
    events = []
    real_policy = m.write_policy_atomic
    real_settings = m.write_settings_atomic
    real_result = m.write_terminal_result
    real_remove_attention = m.remove_attention_marker
    m.write_policy_atomic = lambda policy: (events.append('policy'), real_policy(policy))[1]
    m.activate_policy = lambda _policy: events.append('service')
    m.write_settings_atomic = lambda value, gid: (events.append('settings'), real_settings(value, gid))[1]
    m.remove_attention_marker = lambda: (events.append('marker'), real_remove_attention())[1]
    m.write_terminal_result = lambda value, gid: (events.append('result'), real_result(value, gid))[1]
    assert m.process_one() is True
    assert events == ['policy', 'service', 'settings', 'marker', 'result'], events
    with open(m.SETTINGS_PATH, 'r', encoding='utf-8') as stream:
        committed = json.load(stream)
    assert committed == settings(4, True, ['10.0.0.0/8', '192.168.1.0/24']), committed
    with open(m.POLICY_PATH, 'r', encoding='utf-8') as stream:
        policy = json.load(stream)
    assert policy == {
        'version': 2, 'settingsGeneration': 4, 'rtspEnabled': True,
        'workerUid': 501, 'streamUid': 997,
        'allowedCidrs': ['10.0.0.0/8', '192.168.1.0/24'],
        'udpPortFirst': 24000, 'udpPortLast': 24001,
    }, policy
    assert Path(m.POLICY_PATH).read_bytes() == bytes_for(policy)
    assert stat.S_IMODE(os.stat(m.POLICY_PATH).st_mode) == 0o600
    assert os.stat(m.POLICY_PATH).st_nlink == 1
    assert Path(m.SETTINGS_PATH).read_bytes() == bytes_for(committed)
    assert stat.S_IMODE(os.stat(m.SETTINGS_PATH).st_mode) == 0o640
    assert result(REQUEST_ID) == {
        'version': 1, 'kind': 'settings-mutation', 'requestId': REQUEST_ID,
        'outcome': 'succeeded', 'resultingGeneration': 4,
        'resultingRtspEnabled': True, 'failureCode': None,
    }
    terminal_path = os.path.join(m.RESULT_DIRECTORY, REQUEST_ID + '.json')
    assert Path(terminal_path).read_bytes() == bytes_for(result(REQUEST_ID))
    assert stat.S_IMODE(os.stat(terminal_path).st_mode) == 0o640
    assert os.stat(terminal_path).st_nlink == 1
    assert not os.path.exists(m.ATTENTION_PATH)
    assert not os.path.exists(os.path.join(m.CLAIM_DIRECTORY, REQUEST_ID + '.json'))
`);
  });

  it("reconciles RTSP without rewriting settings and bootstraps deny-all", async () => {
    await execute(String.raw`
real_write_settings = m.write_settings_atomic
with tempfile.TemporaryDirectory() as root:
    configure(root, settings(4, True, ['192.168.1.0/24']))
    publish(reconcile_request())
    before = Path(m.SETTINGS_PATH).read_bytes()
    m.write_settings_atomic = lambda *_args: (_ for _ in ()).throw(
        AssertionError('RTSP reconcile rewrote settings')
    )
    assert m.process_one() is True
    assert Path(m.SETTINGS_PATH).read_bytes() == before
    policy = json.loads(Path(m.POLICY_PATH).read_text(encoding='utf-8'))
    assert policy['settingsGeneration'] == 4
    assert policy['rtspEnabled'] is False
    assert policy['allowedCidrs'] == []
    assert result(SECOND_ID)['outcome'] == 'succeeded'
    os.unlink(m.POLICY_PATH)
    assert m.bootstrap_rtsp() is True
    bootstrapped = json.loads(Path(m.POLICY_PATH).read_text(encoding='utf-8'))
    assert (bootstrapped['settingsGeneration'], bootstrapped['rtspEnabled']) == (4, False)
    assert bootstrapped['allowedCidrs'] == []
    assert Path(m.SETTINGS_PATH).read_bytes() == before

m.write_settings_atomic = real_write_settings
with tempfile.TemporaryDirectory() as root:
    configure(root, settings(4, True, ['192.168.1.0/24']), assets=False)
    publish(reconcile_request())
    assert m.process_one() is True
    assert result(SECOND_ID)['failureCode'] == 'rtsp-assets-absent'
    assert not os.path.exists(m.POLICY_PATH)

with tempfile.TemporaryDirectory() as root:
    configure(root, settings(3, False), assets=False)
    publish(settings_request())
    assert m.process_one() is True
    assert result(REQUEST_ID)['outcome'] == 'succeeded'
    assert json.loads(Path(m.SETTINGS_PATH).read_text())['generation'] == 4
    assert not os.path.exists(m.POLICY_PATH)
`);
  });

  it("distinguishes wholly absent RTSP assets from unsafe or partial installs", async () => {
    await execute(String.raw`
old_policy = {
    'version': 2, 'settingsGeneration': 3, 'rtspEnabled': True,
    'workerUid': 501, 'streamUid': 997,
    'allowedCidrs': ['192.168.1.0/24'],
    'udpPortFirst': 24000, 'udpPortLast': 24001,
}

for unsafe_kind in ('wrong-mode', 'symlink', 'missing-active-unit'):
    with tempfile.TemporaryDirectory() as root:
        configure(root, settings(3, True, ['192.168.1.0/24']), assets=False)
        runtime = os.path.join(root, 'runtime-assets')
        os.mkdir(runtime)
        m.NET_HELPER_PATH = os.path.join(runtime, 'live-stream-net-helper')
        m.STREAM_NET_UNIT_PATH = os.path.join(runtime, 'homeworker-stream-net.service')
        m.rtsp_assets_state = real_rtsp_assets_state
        if unsafe_kind == 'wrong-mode':
            write_file(m.NET_HELPER_PATH, b'helper\n', 0o700)
            write_file(m.STREAM_NET_UNIT_PATH, b'[Service]\n', 0o644)
        elif unsafe_kind == 'symlink':
            target = os.path.join(runtime, 'helper-target')
            write_file(target, b'helper\n', 0o755)
            os.symlink(target, m.NET_HELPER_PATH)
            write_file(m.STREAM_NET_UNIT_PATH, b'[Service]\n', 0o644)
        else:
            write_file(m.NET_HELPER_PATH, b'helper\n', 0o755)
        write_file(m.POLICY_PATH, bytes_for(old_policy), 0o600)
        before_policy = Path(m.POLICY_PATH).read_bytes()
        publish(settings_request(enabled=False, cidrs=['192.168.1.0/24']))

        assert m.process_one() is True
        assert result(REQUEST_ID)['failureCode'] == 'policy-apply-failed', unsafe_kind
        assert json.loads(Path(m.SETTINGS_PATH).read_text()) == settings(
            3, True, ['192.168.1.0/24']
        ), unsafe_kind
        assert Path(m.POLICY_PATH).read_bytes() == before_policy, unsafe_kind

with tempfile.TemporaryDirectory() as root:
    configure(root, settings(3, False), assets=False)
    runtime = os.path.join(root, 'runtime-assets')
    os.mkdir(runtime)
    m.NET_HELPER_PATH = os.path.join(runtime, 'live-stream-net-helper')
    m.STREAM_NET_UNIT_PATH = os.path.join(runtime, 'homeworker-stream-net.service')
    m.rtsp_assets_state = real_rtsp_assets_state
    publish(settings_request())
    assert m.process_one() is True
    assert result(REQUEST_ID)['outcome'] == 'succeeded'
    assert json.loads(Path(m.SETTINGS_PATH).read_text())['generation'] == 4
    assert not os.path.exists(m.POLICY_PATH)
`);
  });

  it("runs only fixed systemctl checks with a sanitized process boundary", async () => {
    await execute(String.raw`
policy = {
    'version': 2, 'settingsGeneration': 4, 'rtspEnabled': False,
    'workerUid': 501, 'streamUid': 997, 'allowedCidrs': [],
    'udpPortFirst': 24000, 'udpPortLast': 24001,
}
calls = []
def run_fixed(argv, **kwargs):
    calls.append((argv, kwargs))
    return SimpleNamespace(returncode=0)
m.subprocess.run = run_fixed
m.read_installed_policy = lambda: policy
m.activate_policy(policy)
assert [call[0] for call in calls] == [
    ['/bin/systemctl', 'restart', 'homeworker-stream-net.service'],
    ['/bin/systemctl', 'is-active', '--quiet', 'homeworker-stream-net.service'],
]
for _argv, kwargs in calls:
    assert kwargs['cwd'] == '/'
    assert kwargs['env'] == {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}
    assert kwargs['shell'] is False
    assert kwargs['stdin'] is m.subprocess.DEVNULL
    assert kwargs['stdout'] is m.subprocess.DEVNULL
    assert kwargs['stderr'] is m.subprocess.DEVNULL
    assert kwargs['check'] is False
    assert kwargs['timeout'] == 15
`);
  });

  it("derives runtime identity and UDP bounds only from fixed local sources", async () => {
    await execute(String.raw`
with tempfile.TemporaryDirectory() as root:
    environment = os.path.join(root, '.env')
    write_file(
        environment,
        b'RTSP_UDP_PORT_FIRST=24010\nRTSP_UDP_PORT_LAST=24011\n',
        0o600,
    )
    m.WORKER_ENV_PATH = environment
    m.pwd.getpwnam = lambda name: (
        SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())
        if name == 'homeworker'
        else SimpleNamespace(pw_uid=os.getuid() + 1, pw_gid=os.getgid() + 1)
    )
    os.environ['RTSP_UDP_PORT_FIRST'] = '1'
    os.environ['RTSP_UDP_PORT_LAST'] = '65535'
    assert m.policy_runtime_values() == (
        os.getuid(), os.getuid() + 1, 24010, 24011
    )
    write_file(
        environment,
        b'RTSP_UDP_PORT_FIRST=' + (b'9' * 5000) + b'\nRTSP_UDP_PORT_LAST=24011\n',
        0o600,
    )
    try:
        m.policy_runtime_values()
        raise AssertionError('unbounded numeric runtime value accepted')
    except m.ApplyFailure as error:
        assert error.code == 'policy-apply-failed'
`);
  });

  it("returns stale and invalid terminal results before removing trusted claims", async () => {
    await execute(String.raw`
with tempfile.TemporaryDirectory() as root:
    configure(root, settings(4, False))
    publish(settings_request(expected=3))
    events = []
    real_result = m.write_terminal_result
    real_remove = m.remove_entry
    m.write_terminal_result = lambda value, gid: (events.append('result'), real_result(value, gid))[1]
    m.remove_entry = lambda fd, name: (events.append('claim'), real_remove(fd, name))[1]
    assert m.process_one() is True
    assert result(REQUEST_ID)['failureCode'] == 'stale-generation'
    assert events.index('result') < events.index('claim'), events
    assert not os.path.exists(m.POLICY_PATH)

with tempfile.TemporaryDirectory() as root:
    configure(root)
    invalid = {**settings_request(), 'command': '/bin/sh'}
    publish(invalid)
    assert m.process_one() is True
    assert result(REQUEST_ID)['failureCode'] == 'request-invalid'
    assert not os.path.exists(os.path.join(m.CLAIM_DIRECTORY, REQUEST_ID + '.json'))
    assert not os.path.exists(m.POLICY_PATH)
`);
  });

  it("returns immediately when the nonblocking global policy lock is busy", async () => {
    await execute(String.raw`
with tempfile.TemporaryDirectory() as root:
    configure(root)
    m.os.geteuid = lambda: 0
    held = m.lock_applier()
    try:
        assert m.main([]) == 0
        assert m.main(['--bootstrap-rtsp']) == 3
    finally:
        os.close(held)
`);
  });

  it("does not mistake a fresh stale request for an interrupted committed replay", async () => {
    await execute(String.raw`
real_claim_replay_state = m.claim_replay_state
with tempfile.TemporaryDirectory() as root:
    configure(root, settings(4, True, ['192.168.1.0/24']), assets=False)
    publish(settings_request(
        request_id=SECOND_ID,
        expected=3,
        enabled=True,
        cidrs=['192.168.1.0/24'],
        rtsp=True,
    ))
    assert m.process_one() is True
    assert result(SECOND_ID)['failureCode'] == 'stale-generation'
    assert json.loads(Path(m.SETTINGS_PATH).read_text())['generation'] == 4

root_metadata = SimpleNamespace(st_uid=71, st_gid=72)
worker_metadata = SimpleNamespace(st_uid=501, st_gid=502)
m.ROOT_UID = 71; m.ROOT_GID = 72
assert real_claim_replay_state(root_metadata, 501, 502) is True
assert real_claim_replay_state(worker_metadata, 501, 502) is False
`);
  });

  it("does not make replay durable before the initial generation CAS succeeds", async () => {
    await execute(String.raw`
class Crash(BaseException):
    pass

with tempfile.TemporaryDirectory() as root:
    configure(root, settings(3, False), assets=False)
    tracked_root_inodes = set()
    real_fchown = m.os.fchown
    m.os.fchown = lambda fd, uid, gid: (
        tracked_root_inodes.add(os.fstat(fd).st_ino),
        real_fchown(fd, uid, gid),
    )[1]
    m.claim_replay_state = lambda metadata, _uid, _gid: (
        metadata.st_ino in tracked_root_inodes
    )
    publish(settings_request(
        request_id=SECOND_ID,
        expected=3,
        enabled=True,
        cidrs=['192.168.1.0/24'],
        rtsp=False,
    ))
    real_read_settings = m.read_settings
    m.read_settings = lambda _gid: (_ for _ in ()).throw(Crash())
    try:
        m.process_one()
        raise AssertionError('pre-CAS crash was swallowed')
    except Crash:
        pass
    claim_path = os.path.join(m.CLAIM_DIRECTORY, SECOND_ID + '.json')
    assert os.stat(claim_path).st_ino not in tracked_root_inodes

    write_file(
        m.SETTINGS_PATH,
        bytes_for(settings(4, True, ['192.168.1.0/24'])),
        0o640,
    )
    m.read_settings = real_read_settings
    assert m.process_one() is True
    assert result(SECOND_ID)['failureCode'] == 'stale-generation'
    assert result(SECOND_ID)['resultingRtspEnabled'] is None
    assert not os.path.exists(m.POLICY_PATH)
`);
  });

  it("seals an accepted request into a new inode before privileged side effects", async () => {
    await execute(String.raw`
class Crash(BaseException):
    pass

with tempfile.TemporaryDirectory() as root:
    configure(root, settings(3, False), assets=False)
    request_path = publish(settings_request(rtsp=True))
    retained_worker_fd = os.open(request_path, os.O_RDWR)
    tracked_root_inodes = set()
    real_fchown = m.os.fchown
    m.os.fchown = lambda fd, uid, gid: (
        tracked_root_inodes.add(os.fstat(fd).st_ino),
        real_fchown(fd, uid, gid),
    )[1]
    m.claim_replay_state = lambda metadata, _uid, _gid: (
        metadata.st_ino in tracked_root_inodes
    )
    real_read_marker = m.read_attention_marker
    m.read_attention_marker = lambda _gid: (_ for _ in ()).throw(Crash())
    try:
        m.process_one()
        raise AssertionError('post-CAS crash was swallowed')
    except Crash:
        pass
    claim_path = os.path.join(m.CLAIM_DIRECTORY, REQUEST_ID + '.json')
    assert os.stat(claim_path).st_ino != os.fstat(retained_worker_fd).st_ino

    changed = bytes_for(settings_request(rtsp=False))
    os.lseek(retained_worker_fd, 0, os.SEEK_SET)
    os.ftruncate(retained_worker_fd, 0)
    os.write(retained_worker_fd, changed)
    os.fsync(retained_worker_fd)
    os.close(retained_worker_fd)
    m.read_attention_marker = real_read_marker

    assert m.process_one() is True
    assert result(REQUEST_ID)['outcome'] == 'succeeded'
    assert result(REQUEST_ID)['resultingRtspEnabled'] is True
    assert json.loads(Path(m.SETTINGS_PATH).read_text())['generation'] == 4
`);
  });

  it("replays a claim after a crash between policy activation and settings commit", async () => {
    await execute(String.raw`
class Crash(BaseException):
    pass

with tempfile.TemporaryDirectory() as root:
    configure(root, settings(3, False))
    publish(settings_request())
    activations = []
    m.activate_policy = lambda policy: activations.append(
        (policy['settingsGeneration'], policy['rtspEnabled'])
    )
    real_write_settings = m.write_settings_atomic
    m.write_settings_atomic = lambda _value, _gid: (_ for _ in ()).throw(Crash())
    try:
        m.process_one()
        raise AssertionError('injected crash was swallowed')
    except Crash:
        pass
    assert activations == [(4, True)]
    assert json.loads(Path(m.SETTINGS_PATH).read_text())['generation'] == 3
    assert json.loads(Path(m.POLICY_PATH).read_text())['settingsGeneration'] == 4
    assert os.path.exists(os.path.join(m.CLAIM_DIRECTORY, REQUEST_ID + '.json'))
    assert not os.path.exists(os.path.join(m.RESULT_DIRECTORY, REQUEST_ID + '.json'))
    m.write_settings_atomic = real_write_settings
    assert m.process_one() is True
    assert activations == [(4, True), (4, True)]
    assert json.loads(Path(m.SETTINGS_PATH).read_text())['generation'] == 4
    assert result(REQUEST_ID)['resultingGeneration'] == 4
`);
  });

  it("replays the committed generation after a crash before terminal result", async () => {
    await execute(String.raw`
class Crash(BaseException):
    pass

with tempfile.TemporaryDirectory() as root:
    configure(root, settings(3, False))
    publish(settings_request())
    real_result = m.write_terminal_result
    m.write_terminal_result = lambda _value, _gid: (_ for _ in ()).throw(Crash())
    try:
        m.process_one()
        raise AssertionError('injected crash was swallowed')
    except Crash:
        pass
    assert json.loads(Path(m.SETTINGS_PATH).read_text())['generation'] == 4
    assert os.path.exists(os.path.join(m.CLAIM_DIRECTORY, REQUEST_ID + '.json'))
    m.claim_replay_state = lambda _metadata, _uid, _gid: True
    m.write_terminal_result = real_result
    settings_writes = []
    real_settings = m.write_settings_atomic
    m.write_settings_atomic = lambda value, gid: (settings_writes.append(value), real_settings(value, gid))[1]
    assert m.process_one() is True
    assert settings_writes == [], settings_writes
    assert json.loads(Path(m.SETTINGS_PATH).read_text())['generation'] == 4
    assert result(REQUEST_ID)['outcome'] == 'succeeded'
`);
  });

  it("treats a valid terminal result as authoritative on claim replay", async () => {
    await execute(String.raw`
with tempfile.TemporaryDirectory() as root:
    configure(root, settings(4, True, ['192.168.1.0/24']))
    request = settings_request(expected=3)
    publish(request)
    request_fd = os.open(m.REQUEST_DIRECTORY, os.O_RDONLY)
    claim_fd = os.open(m.CLAIM_DIRECTORY, os.O_RDONLY)
    assert m.claim_next(request_fd, claim_fd) == REQUEST_ID + '.json'
    os.close(request_fd); os.close(claim_fd)
    terminal = {
        'version': 1, 'kind': 'settings-mutation', 'requestId': REQUEST_ID,
        'outcome': 'succeeded', 'resultingGeneration': 4,
        'resultingRtspEnabled': True, 'failureCode': None,
    }
    write_file(os.path.join(m.RESULT_DIRECTORY, REQUEST_ID + '.json'), bytes_for(terminal), 0o640)
    before_settings = Path(m.SETTINGS_PATH).read_bytes()
    m.activate_policy = lambda _policy: (_ for _ in ()).throw(AssertionError('terminal replay mutated policy'))
    assert m.process_one() is True
    assert Path(m.SETTINGS_PATH).read_bytes() == before_settings
    assert result(REQUEST_ID) == terminal
    assert not os.path.exists(os.path.join(m.CLAIM_DIRECTORY, REQUEST_ID + '.json'))
`);
  });

  it("rejects terminal success that does not correlate to the exact request and committed state", async () => {
    await execute(String.raw`
cases = [
    (
        'mutation-wrong-generation',
        settings(4, True, ['192.168.1.0/24']),
        settings_request(expected=3, rtsp=True),
        {
            'version': 1, 'kind': 'settings-mutation', 'requestId': REQUEST_ID,
            'outcome': 'succeeded', 'resultingGeneration': 5,
            'resultingRtspEnabled': True, 'failureCode': None,
        },
    ),
    (
        'mutation-wrong-rtsp',
        settings(4, True, ['192.168.1.0/24']),
        settings_request(expected=3, rtsp=True),
        {
            'version': 1, 'kind': 'settings-mutation', 'requestId': REQUEST_ID,
            'outcome': 'succeeded', 'resultingGeneration': 4,
            'resultingRtspEnabled': False, 'failureCode': None,
        },
    ),
    (
        'reconcile-wrong-generation',
        settings(4, True, ['192.168.1.0/24']),
        reconcile_request(expected=4, rtsp=False),
        {
            'version': 1, 'kind': 'rtsp-state-reconcile', 'requestId': SECOND_ID,
            'outcome': 'succeeded', 'resultingGeneration': 5,
            'resultingRtspEnabled': False, 'failureCode': None,
        },
    ),
    (
        'reconcile-wrong-rtsp',
        settings(4, True, ['192.168.1.0/24']),
        reconcile_request(expected=4, rtsp=False),
        {
            'version': 1, 'kind': 'rtsp-state-reconcile', 'requestId': SECOND_ID,
            'outcome': 'succeeded', 'resultingGeneration': 4,
            'resultingRtspEnabled': True, 'failureCode': None,
        },
    ),
    (
        'different-candidate',
        settings(4, True, ['192.168.1.0/24']),
        settings_request(
            expected=3,
            enabled=False,
            cidrs=['192.168.1.0/24'],
            rtsp=True,
        ),
        {
            'version': 1, 'kind': 'settings-mutation', 'requestId': REQUEST_ID,
            'outcome': 'succeeded', 'resultingGeneration': 4,
            'resultingRtspEnabled': True, 'failureCode': None,
        },
    ),
]

for label, current, request, terminal in cases:
    with tempfile.TemporaryDirectory() as root:
        configure(root, current)
        m.claim_replay_state = lambda _metadata, _uid, _gid: True
        publish(request)
        terminal_path = os.path.join(
            m.RESULT_DIRECTORY, request['requestId'] + '.json'
        )
        write_file(terminal_path, bytes_for(terminal), 0o640)
        terminal_before = Path(terminal_path).read_bytes()
        settings_before = Path(m.SETTINGS_PATH).read_bytes()
        try:
            m.process_one()
            raise AssertionError(label + ' terminal accepted')
        except RuntimeError:
            pass
        claim_path = os.path.join(
            m.CLAIM_DIRECTORY, request['requestId'] + '.json'
        )
        assert os.path.exists(claim_path), label
        assert Path(terminal_path).read_bytes() == terminal_before, label
        assert Path(m.SETTINGS_PATH).read_bytes() == settings_before, label
`);
  });

  it("accepts a failed terminal only with sealed root-owned request evidence", async () => {
    await execute(String.raw`
failed = {
    'version': 1, 'kind': 'settings-mutation', 'requestId': REQUEST_ID,
    'outcome': 'failed', 'resultingGeneration': None,
    'resultingRtspEnabled': None, 'failureCode': 'policy-apply-failed',
}

with tempfile.TemporaryDirectory() as root:
    configure(root, settings(3, False))
    publish(settings_request())
    result_path = os.path.join(m.RESULT_DIRECTORY, REQUEST_ID + '.json')
    write_file(result_path, bytes_for(failed), 0o640)
    try:
        m.process_one()
        raise AssertionError('ambiguous fresh failed result accepted')
    except RuntimeError:
        pass
    assert os.path.exists(os.path.join(m.CLAIM_DIRECTORY, REQUEST_ID + '.json'))
    assert Path(result_path).read_bytes() == bytes_for(failed)

with tempfile.TemporaryDirectory() as root:
    configure(root, settings(3, False))
    m.claim_replay_state = lambda _metadata, _uid, _gid: True
    publish(settings_request())
    result_path = os.path.join(m.RESULT_DIRECTORY, REQUEST_ID + '.json')
    write_file(result_path, bytes_for(failed), 0o640)
    assert m.process_one() is True
    assert not os.path.exists(os.path.join(m.CLAIM_DIRECTORY, REQUEST_ID + '.json'))
    assert Path(result_path).read_bytes() == bytes_for(failed)
`);
  });

  it("removes only an acknowledged root-owned terminal result and retains invalid acknowledgements", async () => {
    await execute(String.raw`
terminal = {
    'version': 1, 'kind': 'settings-mutation', 'requestId': REQUEST_ID,
    'outcome': 'succeeded', 'resultingGeneration': 4,
    'resultingRtspEnabled': True, 'failureCode': None,
}
with tempfile.TemporaryDirectory() as root:
    configure(root)
    result_path = os.path.join(m.RESULT_DIRECTORY, REQUEST_ID + '.json')
    ack_path = os.path.join(m.ACK_DIRECTORY, REQUEST_ID + '.ack')
    write_file(result_path, bytes_for(terminal), 0o640)
    write_file(ack_path, b'', 0o600)
    assert m.process_one() is False
    assert not os.path.exists(result_path)
    assert not os.path.exists(ack_path)

with tempfile.TemporaryDirectory() as root:
    configure(root)
    result_path = os.path.join(m.RESULT_DIRECTORY, REQUEST_ID + '.json')
    ack_path = os.path.join(m.ACK_DIRECTORY, REQUEST_ID + '.ack')
    write_file(result_path, bytes_for(terminal), 0o640)
    write_file(ack_path, b'x', 0o600)
    assert m.process_one() is False
    assert os.path.exists(result_path)
    assert os.path.exists(ack_path)

with tempfile.TemporaryDirectory() as root:
    configure(root)
    ack_path = os.path.join(m.ACK_DIRECTORY, REQUEST_ID + '.ack')
    write_file(ack_path, b'', 0o600)
    assert m.process_one() is False
    assert os.path.exists(ack_path)

with tempfile.TemporaryDirectory() as root:
    configure(root)
    result_path = os.path.join(m.RESULT_DIRECTORY, REQUEST_ID + '.json')
    ack_path = os.path.join(m.ACK_DIRECTORY, REQUEST_ID + '.ack')
    write_file(result_path, bytes_for(terminal), 0o640)
    write_file(ack_path, b'', 0o600)
    os.link(ack_path, ack_path + '.linked')
    assert m.process_one() is False
    assert os.path.exists(result_path)
    assert os.path.exists(ack_path)

class AckCleanupCrash(BaseException):
    pass

with tempfile.TemporaryDirectory() as root:
    configure(root)
    result_path = os.path.join(m.RESULT_DIRECTORY, REQUEST_ID + '.json')
    ack_path = os.path.join(m.ACK_DIRECTORY, REQUEST_ID + '.ack')
    write_file(result_path, bytes_for(terminal), 0o640)
    write_file(ack_path, b'', 0o600)
    real_remove = m.remove_entry
    m.remove_entry = lambda fd, name: (
        (_ for _ in ()).throw(AckCleanupCrash())
        if name.endswith('.json')
        else real_remove(fd, name)
    )
    try:
        m.process_one()
        raise AssertionError('ack cleanup crash was swallowed')
    except AckCleanupCrash:
        pass
    assert not os.path.exists(ack_path)
    assert os.path.exists(result_path)

    m.remove_entry = real_remove
    write_file(ack_path, b'', 0o600)
    assert m.process_one() is False
    assert not os.path.exists(ack_path)
    assert not os.path.exists(result_path)
`);
  });

  it("terminalizes a valid claim when the root bundle gate fails", async () => {
    await execute(String.raw`
with tempfile.TemporaryDirectory() as root:
    configure(root, settings(3, False))
    publish(settings_request())
    m.validate_root_bundle = lambda: (_ for _ in ()).throw(
        RuntimeError('helper-version-mismatch')
    )
    assert m.process_one() is True
    assert result(REQUEST_ID)['failureCode'] == 'helper-version-mismatch'
    assert json.loads(Path(m.SETTINGS_PATH).read_text())['generation'] == 3
    assert not os.path.exists(m.POLICY_PATH)
`);
  });

  it("fails before commit on an unsafe marker but reports success when only post-commit removal fails", async () => {
    await execute(String.raw`
with tempfile.TemporaryDirectory() as root:
    configure(root, settings(3, False))
    write_file(m.ATTENTION_PATH, b'{"version":1,"code":"legacy-values-invalid"}\n', 0o600)
    publish(settings_request())
    assert m.process_one() is True
    assert result(REQUEST_ID)['failureCode'] == 'settings-state-unsafe'
    assert json.loads(Path(m.SETTINGS_PATH).read_text())['generation'] == 3
    assert not os.path.exists(m.POLICY_PATH)
    assert os.path.exists(m.ATTENTION_PATH)

with tempfile.TemporaryDirectory() as root:
    configure(root, settings(3, False))
    write_file(m.ATTENTION_PATH, b'{"version":1,"code":"legacy-values-invalid"}\n', 0o640)
    publish(settings_request())
    m.remove_attention_marker = lambda: (_ for _ in ()).throw(OSError('injected unlink failure'))
    assert m.process_one() is True
    assert result(REQUEST_ID)['outcome'] == 'succeeded'
    assert json.loads(Path(m.SETTINGS_PATH).read_text())['generation'] == 4
    assert os.path.exists(m.ATTENTION_PATH)
`);
  });

  it("rejects a stale bundle version or active unit that differs from the bundled unit", async () => {
    await execute(String.raw`
import hashlib

with tempfile.TemporaryDirectory() as root:
    m.ROOT_UID = os.getuid(); m.ROOT_GID = os.getgid()
    m.APPLIER_VERSION = '7'
    m.VERSION_PATH = os.path.join(root, 'version')
    m.MANIFEST_PATH = os.path.join(root, 'manifest')
    m.APPLIER_PATH = os.path.join(root, 'applier')
    m.NET_HELPER_PATH = os.path.join(root, 'net-helper')
    m.BUNDLED_UNIT_PATH = os.path.join(root, 'bundled.service')
    m.ACTIVE_UNIT_PATH = os.path.join(root, 'active.service')
    assets = {
        m.APPLIER_PATH: (b'applier\n', 0o755),
        m.NET_HELPER_PATH: (b'net helper\n', 0o755),
        m.BUNDLED_UNIT_PATH: (b'[Service]\nExecStart=/fixed\n', 0o644),
    }
    for path, (body, mode) in assets.items():
        write_file(path, body, mode)
    write_file(m.ACTIVE_UNIT_PATH, assets[m.BUNDLED_UNIT_PATH][0], 0o644)
    write_file(m.VERSION_PATH, b'7\n', 0o644)
    lines = ['version 7']
    for path, (_body, mode) in assets.items():
        digest = hashlib.sha256(Path(path).read_bytes()).hexdigest()
        lines.append('%s %04o %s' % (digest, mode, path))
    write_file(m.MANIFEST_PATH, ('\n'.join(lines) + '\n').encode(), 0o644)
    m.validate_root_bundle()
    os.chmod(m.ACTIVE_UNIT_PATH, 0o600)
    try:
        m.validate_root_bundle()
        raise AssertionError('wrong active unit mode accepted')
    except RuntimeError as error:
        assert str(error) == 'helper-version-mismatch'
    os.chmod(m.ACTIVE_UNIT_PATH, 0o644)
    os.link(m.ACTIVE_UNIT_PATH, m.ACTIVE_UNIT_PATH + '.linked')
    try:
        m.validate_root_bundle()
        raise AssertionError('multi-link active unit accepted')
    except RuntimeError as error:
        assert str(error) == 'helper-version-mismatch'
    os.unlink(m.ACTIVE_UNIT_PATH + '.linked')
    write_file(m.ACTIVE_UNIT_PATH, b'[Service]\nExecStart=/other\n', 0o644)
    try:
        m.validate_root_bundle()
        raise AssertionError('different active unit accepted')
    except RuntimeError as error:
        assert str(error) == 'helper-version-mismatch'
    write_file(m.ACTIVE_UNIT_PATH, assets[m.BUNDLED_UNIT_PATH][0], 0o644)
    write_file(m.VERSION_PATH, b'8\n', 0o644)
    try:
        m.validate_root_bundle()
        raise AssertionError('stale helper version accepted')
    except RuntimeError as error:
        assert str(error) == 'helper-version-mismatch'
`);
  });

  it("keeps bootstrap root-only and exposes no argument-bearing command surface", async () => {
    await execute(String.raw`
calls = []
m.bootstrap_rtsp = lambda: calls.append('bootstrap') or True
m.os.geteuid = lambda: 1
assert m.main(['--bootstrap-rtsp']) == 1
assert calls == []
m.os.geteuid = lambda: 0
assert m.main(['--bootstrap-rtsp', '/tmp/caller-path']) == 2
assert m.main(['--unknown']) == 2
assert calls == []
assert m.main(['--bootstrap-rtsp']) == 0
assert calls == ['bootstrap']
`);
  });
});
