#!/usr/bin/env python3
"""Root-owned, fixed-schema feature installer spool consumer.

All production locations are constants.  Tests import this module and patch
the constants/functions directly; this program deliberately has no test-mode
environment overrides.
"""
import fcntl
import grp
import hashlib
import json
import os
import pwd
import re
import signal
import stat
import subprocess
import sys
import uuid

INSTALL_ROOT = '/var/lib/home-worker'
REQUEST_DIRECTORY = INSTALL_ROOT + '/feature-install-requests'
CLAIM_DIRECTORY = INSTALL_ROOT + '/feature-install-claims'
RESULT_DIRECTORY = INSTALL_ROOT + '/feature-install-results'
LOCK_PATH = '/run/lock/homeworker-feature-install.lock'
ROUTINES_PATH = '/usr/lib/home-worker/install-feature-routines'
VERSION_PATH = '/usr/lib/home-worker/feature-installer.version'
MANIFEST_PATH = '/usr/lib/home-worker/feature-installer.manifest'
INSTALLER_VERSION = '1'
WORKER_NAME = 'homeworker'
MAX_BYTES = 4096
TIMEOUT_SECONDS = 30 * 60
CHECK_TIMEOUT_SECONDS = 15
JOB_ID = re.compile(r'^[A-Za-z0-9_-]{16}$')
ENTRY_NAME = re.compile(r'^([A-Za-z0-9_-]{16})\.json$')
FEATURES = frozenset(('digital', 'uart', 'zigbee', 'motion', 'rtsp'))
RESTART_SCOPES = {
    'digital': 'worker', 'uart': 'host', 'zigbee': 'worker',
    'motion': 'supervisor', 'rtsp': 'supervisor',
}
SAFE_ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C', 'HOME_WORKER_PRIVILEGED': '1'}
O_CLOEXEC = getattr(os, 'O_CLOEXEC', 0)
O_NOFOLLOW = getattr(os, 'O_NOFOLLOW', 0)


class InvalidRequest(ValueError):
    pass


ROOT_BUNDLE_FILES = {
    '/usr/lib/home-worker/feature-installer': 0o755,
    '/usr/lib/home-worker/install-feature-routines': 0o755,
    '/usr/lib/home-worker/live-stream-net-helper': 0o755,
    '/usr/lib/home-worker/live-stream-ffmpeg-runner': 0o755,
    '/usr/lib/home-worker/systemd/homeworker-feature-install.service': 0o644,
    '/usr/lib/home-worker/systemd/homeworker-feature-supervisor-restart.service': 0o644,
    '/usr/lib/home-worker/systemd/homeworker-feature-host-reboot.service': 0o644,
    '/usr/lib/home-worker/systemd/homeworker-ffmpeg-stream@.service': 0o644,
    '/usr/lib/home-worker/systemd/homeworker-stream-net.service': 0o644,
    '/usr/lib/home-worker/systemd/homeworker-stream-systemd.rules': 0o644,
}


def worker_ids():
    entry = pwd.getpwnam(WORKER_NAME)
    return entry.pw_uid, entry.pw_gid


def root_owned_file(path, mode):
    try:
        value = os.stat(path, follow_symlinks=False)
    except OSError:
        return False
    return (stat.S_ISREG(value.st_mode) and value.st_nlink == 1 and value.st_uid == 0
            and value.st_gid == 0 and stat.S_IMODE(value.st_mode) == mode)


def file_digest(path):
    fd = os.open(path, os.O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
    try:
        digest = hashlib.sha256()
        while True:
            chunk = os.read(fd, 65536)
            if not chunk:
                return digest.hexdigest()
            digest.update(chunk)
    finally:
        os.close(fd)


def validate_root_bundle():
    """Reject stale/tampered root assets before a request can run a routine."""
    if not root_owned_file(VERSION_PATH, 0o644) or not root_owned_file(MANIFEST_PATH, 0o644):
        raise RuntimeError('helper-version-mismatch')
    try:
        with open(VERSION_PATH, 'r', encoding='ascii') as stream:
            if stream.read() != INSTALLER_VERSION + '\n':
                raise RuntimeError('helper-version-mismatch')
        with open(MANIFEST_PATH, 'r', encoding='ascii') as stream:
            lines = stream.read().splitlines()
    except (OSError, UnicodeError):
        raise RuntimeError('helper-version-mismatch')
    if not lines or lines[0] != 'version ' + INSTALLER_VERSION or len(lines) != len(ROOT_BUNDLE_FILES) + 1:
        raise RuntimeError('helper-version-mismatch')
    seen = set()
    for line in lines[1:]:
        pieces = line.split(' ', 2)
        if len(pieces) != 3:
            raise RuntimeError('helper-version-mismatch')
        digest, mode_text, path = pieces
        if path not in ROOT_BUNDLE_FILES or path in seen or mode_text != format(ROOT_BUNDLE_FILES[path], '04o'):
            raise RuntimeError('helper-version-mismatch')
        if not re.fullmatch(r'[0-9a-f]{64}', digest) or not root_owned_file(path, ROOT_BUNDLE_FILES[path]):
            raise RuntimeError('helper-version-mismatch')
        try:
            actual_digest = file_digest(path)
        except OSError:
            raise RuntimeError('helper-version-mismatch')
        if actual_digest != digest:
            raise RuntimeError('helper-version-mismatch')
        seen.add(path)
    if seen != set(ROOT_BUNDLE_FILES):
        raise RuntimeError('helper-version-mismatch')


def fsync_directory(fd):
    os.fsync(fd)


def validate_parent(path):
    parent = os.path.dirname(path)
    while True:
        value = os.stat(parent, follow_symlinks=False)
        if (not stat.S_ISDIR(value.st_mode) or value.st_uid != 0
                or (stat.S_IMODE(value.st_mode) & 0o022)):
            raise RuntimeError('unsafe spool parent')
        if parent == '/':
            return
        parent = os.path.dirname(parent)


def directory_fd(path, expected_uid, expected_gid, expected_mode):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
    current = os.fstat(fd)
    if (not stat.S_ISDIR(current.st_mode) or current.st_uid != expected_uid
            or current.st_gid != expected_gid or stat.S_IMODE(current.st_mode) != expected_mode):
        os.close(fd)
        raise RuntimeError('unsafe spool directory')
    return fd


def validate_layout(worker_uid, worker_gid):
    validate_parent(INSTALL_ROOT)
    root = os.stat(INSTALL_ROOT, follow_symlinks=False)
    if not stat.S_ISDIR(root.st_mode) or root.st_uid != 0 or (stat.S_IMODE(root.st_mode) & 0o022):
        raise RuntimeError('unsafe install root')
    expected = ((REQUEST_DIRECTORY, 0, worker_gid, 0o770),
                (CLAIM_DIRECTORY, 0, 0, 0o700),
                (RESULT_DIRECTORY, 0, worker_gid, 0o770))
    for path, uid, gid, mode in expected:
        value = os.stat(path, follow_symlinks=False)
        if (not stat.S_ISDIR(value.st_mode) or value.st_uid != uid or value.st_gid != gid
                or stat.S_IMODE(value.st_mode) != mode):
            raise RuntimeError('unsafe spool directory')


def lock_installer():
    parent = os.stat(os.path.dirname(LOCK_PATH), follow_symlinks=False)
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != 0:
        raise RuntimeError('unsafe installer lock parent')
    fd = os.open(LOCK_PATH, os.O_RDWR | os.O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0o600)
    try:
        value = os.fstat(fd)
        if (not stat.S_ISREG(value.st_mode) or value.st_uid != 0 or value.st_gid != 0
                or value.st_nlink != 1 or stat.S_IMODE(value.st_mode) != 0o600):
            raise RuntimeError('unsafe installer lock')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fd
    except BaseException:
        os.close(fd)
        raise


def exact_entries(fd):
    return sorted(name for name in os.listdir(fd) if ENTRY_NAME.fullmatch(name))


def claim_next(request_fd, claim_fd):
    claims = exact_entries(claim_fd)
    if claims:
        return claims[0]
    for name in exact_entries(request_fd):
        try:
            os.rename(name, name, src_dir_fd=request_fd, dst_dir_fd=claim_fd)
            # Persist the destination first: only then may the source removal
            # be considered durable across a cross-directory rename.
            fsync_directory(claim_fd)
            fsync_directory(request_fd)
            return name
        except FileNotFoundError:
            continue
        except FileExistsError:
            continue
    return None


def open_claim(claim_fd, name, worker_uid, worker_gid):
    fd = os.open(name, os.O_RDONLY | os.O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW, dir_fd=claim_fd)
    try:
        value = os.fstat(fd)
        worker_owned = value.st_uid == worker_uid and value.st_gid == worker_gid
        root_owned = value.st_uid == 0 and value.st_gid == 0
        if (not stat.S_ISREG(value.st_mode) or value.st_nlink != 1
                or stat.S_IMODE(value.st_mode) != 0o600 or not 1 <= value.st_size <= MAX_BYTES
                or not (worker_owned or root_owned)):
            raise InvalidRequest('unsafe claim')
        # A rename can survive a power loss before chown.  Normalize only that
        # exact worker-owned transient state, using the already-validated FD.
        if worker_owned:
            os.fchown(fd, 0, 0)
            os.fchmod(fd, 0o600)
            os.fsync(fd)
            value = os.fstat(fd)
            if value.st_uid != 0 or value.st_gid != 0 or stat.S_IMODE(value.st_mode) != 0o600:
                raise InvalidRequest('claim normalization failed')
        data = os.read(fd, MAX_BYTES + 1)
        if len(data) != value.st_size or len(data) > MAX_BYTES:
            raise InvalidRequest('claim changed while read')
        return data
    finally:
        os.close(fd)


def no_duplicates(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise InvalidRequest('duplicate key')
        value[key] = item
    return value


def parse_request(data, filename):
    try:
        raw = data.decode('utf-8', 'strict')
        value = json.loads(raw, object_pairs_hook=no_duplicates)
    except (UnicodeDecodeError, json.JSONDecodeError, InvalidRequest) as error:
        raise InvalidRequest('invalid JSON') from error
    if not isinstance(value, dict) or set(value) != {'feature', 'jobId', 'version'}:
        raise InvalidRequest('request schema')
    if value['version'] != 1 or isinstance(value['version'], bool):
        raise InvalidRequest('request version')
    if not isinstance(value['jobId'], str) or not JOB_ID.fullmatch(value['jobId']):
        raise InvalidRequest('request job id')
    if not isinstance(value['feature'], str) or value['feature'] not in FEATURES:
        raise InvalidRequest('request feature')
    matched = ENTRY_NAME.fullmatch(filename)
    if not matched or matched.group(1) != value['jobId']:
        raise InvalidRequest('claim filename mismatch')
    return value


def canonical_request(request):
    return (json.dumps({'feature': request['feature'], 'jobId': request['jobId'], 'version': 1},
                       separators=(',', ':'), sort_keys=True) + '\n').encode('utf-8')


def open_checked_result(result_fd, name, worker_uid, worker_gid):
    fd = os.open(name, os.O_RDONLY | os.O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW, dir_fd=result_fd)
    try:
        value = os.fstat(fd)
        if (not stat.S_ISREG(value.st_mode) or value.st_nlink != 1 or value.st_uid != 0
                or value.st_gid != worker_gid or stat.S_IMODE(value.st_mode) != 0o640
                or not 1 <= value.st_size <= MAX_BYTES):
            raise InvalidRequest('unsafe result')
        data = os.read(fd, MAX_BYTES + 1)
        if len(data) != value.st_size or len(data) > MAX_BYTES:
            raise InvalidRequest('result changed while read')
        return data
    finally:
        os.close(fd)


def parse_result(data, request):
    try:
        value = json.loads(data.decode('utf-8', 'strict'), object_pairs_hook=no_duplicates)
    except (UnicodeDecodeError, json.JSONDecodeError, InvalidRequest) as error:
        raise InvalidRequest('invalid result') from error
    expected = {'version', 'jobId', 'feature', 'outcome', 'failureCode', 'privilegedReady', 'restartScope'}
    if not isinstance(value, dict) or set(value) != expected:
        raise InvalidRequest('result schema')
    if value.get('version') != 1 or isinstance(value.get('version'), bool):
        raise InvalidRequest('result version')
    if value.get('jobId') != request['jobId'] or value.get('feature') != request['feature']:
        raise InvalidRequest('result identity')
    if not isinstance(value.get('privilegedReady'), bool):
        raise InvalidRequest('result ready')
    if value['outcome'] == 'succeeded':
        if value['failureCode'] is not None or not value['privilegedReady'] or value['restartScope'] not in ('worker', 'supervisor', 'host'):
            raise InvalidRequest('result success')
    elif value['outcome'] == 'failed':
        if (value['failureCode'] not in ('request-invalid', 'dependency-install-failed', 'privileged-verification-failed', 'helper-version-mismatch', 'interrupted')
                or value['privilegedReady'] is not False or value['restartScope'] is not None):
            raise InvalidRequest('result failure')
    else:
        raise InvalidRequest('result outcome')
    return value


def write_atomic(result_fd, name, payload, worker_gid):
    temporary = '.%s.%s.tmp' % (name, uuid.uuid4().hex)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | O_CLOEXEC, 0o640, dir_fd=result_fd)
    try:
        os.fchown(fd, 0, worker_gid)
        os.fchmod(fd, 0o640)
        view = memoryview(payload)
        while view:
            written = os.write(fd, view)
            view = view[written:]
        os.fsync(fd)
    finally:
        os.close(fd)
    try:
        os.replace(temporary, name, src_dir_fd=result_fd, dst_dir_fd=result_fd)
        fsync_directory(result_fd)
    except BaseException:
        try:
            os.unlink(temporary, dir_fd=result_fd)
        except FileNotFoundError:
            pass
        raise


def result_payload(request, outcome, failure=None):
    ready = outcome == 'succeeded'
    return (json.dumps({
        'failureCode': failure, 'feature': request['feature'], 'jobId': request['jobId'],
        'outcome': outcome, 'privilegedReady': ready,
        'restartScope': RESTART_SCOPES[request['feature']] if ready else None, 'version': 1,
    }, separators=(',', ':'), sort_keys=True) + '\n').encode('utf-8')


def write_marker(result_fd, request, worker_gid):
    write_atomic(result_fd, request['jobId'] + '.running', canonical_request(request), worker_gid)


def remove_entry(directory_fd, name):
    try:
        os.unlink(name, dir_fd=directory_fd)
    except FileNotFoundError:
        return
    fsync_directory(directory_fd)


def run_routine(feature):
    try:
        process = subprocess.Popen([ROUTINES_PATH, feature], cwd='/', env=SAFE_ENV, shell=False,
                                   stdin=subprocess.DEVNULL, stdout=None, stderr=None, start_new_session=True)
    except OSError:
        return 'failed'
    try:
        return 'ok' if process.wait(timeout=TIMEOUT_SECONDS) == 0 else 'failed'
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
        return 'interrupted'


def verify_feature(feature):
    commands = {
        'digital': (('/usr/bin/which', 'pigpiod'), ('/bin/systemctl', 'is-active', '--quiet', 'pigpiod.service'), ('/usr/bin/pigs', 't')),
        'uart': (('/usr/bin/test', '-e', '/dev/serial0'),),
        'zigbee': (('/usr/bin/which', 'mosquitto'), ('/bin/systemctl', 'is-active', '--quiet', 'mosquitto.service')),
        'motion': (('/usr/bin/which', 'motion'), ('/usr/bin/which', 'ffmpeg'), ('/usr/bin/test', '-f', '/etc/motion/motion.conf'), ('/usr/bin/test', '-d', '/home/pi/motion/videos'), ('/bin/systemctl', 'is-active', '--quiet', 'motion.service')),
        'rtsp': (('/usr/bin/which', 'ffmpeg'), ('/usr/bin/which', 'cloudflared'), ('/usr/bin/test', '-f', '/etc/home-worker/live-stream-policy.json'), ('/usr/bin/test', '-f', '/etc/systemd/system/homeworker-stream-net.service'), ('/bin/systemctl', 'is-active', '--quiet', 'homeworker-stream-net.service')),
    }[feature]
    try:
        commands_ok = all(subprocess.run(command, cwd='/', env=SAFE_ENV, shell=False,
                                  stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                  stderr=subprocess.DEVNULL, check=False,
                                  timeout=CHECK_TIMEOUT_SECONDS).returncode == 0 for command in commands)
        if not commands_ok:
            return False
        if feature == 'motion':
            motion_uid = pwd.getpwnam('motion').pw_uid
            motion_gid = grp.getgrnam('motion').gr_gid
            return (owned_regular('/etc/motion/motion.conf', 0, 0, 0o644)
                    and owned_directory('/home/pi/motion/videos', motion_uid, motion_gid, 0o775))
        if feature == 'rtsp':
            return (owned_regular('/etc/home-worker/live-stream-policy.json', 0, 0, 0o600)
                    and owned_regular('/etc/systemd/system/homeworker-stream-net.service', 0, 0, 0o644))
        return True
    except (OSError, subprocess.TimeoutExpired):
        return False


def owned_regular(path, uid, gid, mode):
    value = os.stat(path, follow_symlinks=False)
    return (stat.S_ISREG(value.st_mode) and value.st_nlink == 1 and value.st_uid == uid
            and value.st_gid == gid and stat.S_IMODE(value.st_mode) == mode)


def owned_directory(path, uid, gid, mode):
    value = os.stat(path, follow_symlinks=False)
    return (stat.S_ISDIR(value.st_mode) and value.st_uid == uid and value.st_gid == gid
            and stat.S_IMODE(value.st_mode) == mode)


def recover_committed_markers(result_fd, worker_uid, worker_gid):
    """Clear a marker left after terminal+claim commit but before marker unlink."""
    for name in sorted(entry for entry in os.listdir(result_fd) if entry.endswith('.running')):
        job_id = name[:-8]
        if not JOB_ID.fullmatch(job_id):
            continue
        try:
            request = parse_request(open_checked_result(result_fd, name, worker_uid, worker_gid), job_id + '.json')
            terminal = open_checked_result(result_fd, job_id + '.json', worker_uid, worker_gid)
            parse_result(terminal, request)
        except (FileNotFoundError, InvalidRequest):
            continue
        remove_entry(result_fd, name)


def process_one():
    worker_uid, worker_gid = worker_ids()
    validate_layout(worker_uid, worker_gid)
    request_fd = directory_fd(REQUEST_DIRECTORY, 0, worker_gid, 0o770)
    claim_fd = directory_fd(CLAIM_DIRECTORY, 0, 0, 0o700)
    result_fd = directory_fd(RESULT_DIRECTORY, 0, worker_gid, 0o770)
    try:
        recover_committed_markers(result_fd, worker_uid, worker_gid)
        name = claim_next(request_fd, claim_fd)
        if name is None:
            return False
        try:
            request = parse_request(open_claim(claim_fd, name, worker_uid, worker_gid), name)
        except InvalidRequest:
            # No trusted feature identity exists, so never manufacture output.
            remove_entry(claim_fd, name)
            return True
        result_name = request['jobId'] + '.json'
        try:
            validate_root_bundle()
        except RuntimeError:
            write_atomic(result_fd, result_name, result_payload(request, 'failed', 'helper-version-mismatch'), worker_gid)
            remove_entry(claim_fd, name)
            remove_entry(result_fd, request['jobId'] + '.running')
            return True
        try:
            parse_result(open_checked_result(result_fd, result_name, worker_uid, worker_gid), request)
            # A terminal result is authoritative, including after a crash.
            remove_entry(claim_fd, name)
            remove_entry(result_fd, request['jobId'] + '.running')
            return True
        except FileNotFoundError:
            pass
        except InvalidRequest:
            # A malformed root-owned result is an operator-visible failure.
            write_atomic(result_fd, result_name, result_payload(request, 'failed', 'request-invalid'), worker_gid)
            remove_entry(claim_fd, name)
            remove_entry(result_fd, request['jobId'] + '.running')
            return True
        write_marker(result_fd, request, worker_gid)
        routine_status = run_routine(request['feature'])
        verification_ok = verify_feature(request['feature'])
        if routine_status == 'ok' and verification_ok:
            payload = result_payload(request, 'succeeded')
        elif routine_status == 'interrupted':
            payload = result_payload(request, 'failed', 'interrupted')
        elif routine_status != 'ok':
            payload = result_payload(request, 'failed', 'dependency-install-failed')
        else:
            payload = result_payload(request, 'failed', 'privileged-verification-failed')
        # Commit barrier ordering: terminal -> claim -> marker, each durable.
        write_atomic(result_fd, result_name, payload, worker_gid)
        remove_entry(claim_fd, name)
        remove_entry(result_fd, request['jobId'] + '.running')
        return True
    finally:
        os.close(result_fd)
        os.close(claim_fd)
        os.close(request_fd)


def main():
    if len(sys.argv) == 2 and sys.argv[1] == '--validate-installation':
        try:
            validate_root_bundle()
            return 0
        except RuntimeError:
            return 3
    if len(sys.argv) == 3 and sys.argv[1] == '--verify-feature' and sys.argv[2] in FEATURES:
        try:
            validate_root_bundle()
            return 0 if verify_feature(sys.argv[2]) else 4
        except RuntimeError:
            return 3
    if len(sys.argv) != 1:
        return 2
    try:
        lock = lock_installer()
    except BlockingIOError:
        return 0
    try:
        process_one()
        return 0
    finally:
        os.close(lock)


if __name__ == '__main__':
    sys.exit(main())
