#!/usr/bin/env python3
"""Root-owned, fixed-schema feature installer spool consumer.

All production locations are constants.  Tests import this module and patch
the constants/functions directly; this program deliberately has no test-mode
environment overrides.
"""
import fcntl
import grp
import hashlib
import importlib.machinery
import importlib.util
import ipaddress
import json
import os
import pwd
import re
import secrets
import signal
import stat
import subprocess
import sys
import syslog
import uuid

INSTALL_ROOT = '/var/lib/home-worker'
REQUEST_DIRECTORY = INSTALL_ROOT + '/feature-install-requests'
CLAIM_DIRECTORY = INSTALL_ROOT + '/feature-install-claims'
RESULT_DIRECTORY = INSTALL_ROOT + '/feature-install-results'
LOCK_PATH = '/run/lock/homeworker-feature-install.lock'
ROUTINES_PATH = '/usr/lib/home-worker/install-feature-routines'
VERSION_PATH = '/usr/lib/home-worker/feature-installer.version'
MANIFEST_PATH = '/usr/lib/home-worker/feature-installer.manifest'
INSTALLER_VERSION = '8'
WORKER_NAME = 'homeworker'
STREAM_NAME = 'homeworker-stream'
STREAM_GROUP = 'homeworker-stream'
POLICY_INSPECTOR_PATH = '/usr/lib/home-worker/live-stream-policy-inspector'
LIVE_VIEW_APPLIER_PATH = '/usr/lib/home-worker/live-view-policy-applier'
STREAM_NET_BUNDLED_UNIT_PATH = '/usr/lib/home-worker/systemd/homeworker-stream-net.service'
STREAM_NET_ACTIVE_UNIT_PATH = '/etc/systemd/system/homeworker-stream-net.service'
LIVE_VIEW_BUNDLED_UNIT_PATH = '/usr/lib/home-worker/systemd/homeworker-live-view-policy-apply.service'
LIVE_VIEW_ACTIVE_UNIT_PATH = '/etc/systemd/system/homeworker-live-view-policy-apply.service'
POLICY_OWNER_UID = 0
POLICY_OWNER_GID = 0
ROOT_UID = 0
ROOT_GID = 0
LIVE_STREAM_POLICY_PATH = '/etc/home-worker/live-stream-policy.json'
# The summary path is spelled here, in the inspector's SUMMARY_PATH, and in the
# routine that writes it. Production agrees by construction and the test harness
# overrides each independently, so nothing proves they stay in step -- keep them
# together when any one of them moves.
LIVE_STREAM_SUMMARY_PATH = '/etc/home-worker/live-stream-policy.summary.json'
WORKER_ENV_PATH = '/opt/home-worker/.env'
LIVE_VIEW_SETTINGS_PATH = INSTALL_ROOT + '/live-view-settings.json'
LIVE_VIEW_ATTENTION_PATH = INSTALL_ROOT + '/live-view-settings-migration-attention.json'
MAX_BYTES = 4096
MAX_POLICY_BYTES = 64 * 1024
MAX_ENV_BYTES = 64 * 1024
MAX_ALLOWED_CIDRS = 16
TIMEOUT_SECONDS = 30 * 60
CHECK_TIMEOUT_SECONDS = 15
# The applier's hardened systemd operation is bounded by TimeoutStartSec=60.
# The direct installer reset includes process startup and teardown around that
# complete operation, so its caller bound must be strictly larger.
LIVE_VIEW_RESET_TIMEOUT_SECONDS = 75
JOB_ID = re.compile(r'^[A-Za-z0-9_-]{16}$')
ENTRY_NAME = re.compile(r'^([A-Za-z0-9_-]{16})\.json$')
FEATURES = frozenset(('digital', 'uart', 'zigbee', 'motion', 'rtsp'))
RESTART_SCOPES = {
    'digital': 'worker', 'uart': 'host', 'zigbee': 'worker',
    'motion': 'supervisor', 'rtsp': 'supervisor',
}
SAFE_ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C', 'HOME_WORKER_PRIVILEGED': '1'}
# The closed contract with the rtsp routine: one reserved exit status per
# operator-visible cause. Every other nonzero status is an ordinary dependency
# failure. Routine stdout/stderr stay attached to the root journal, so the
# status is the only thing that ever crosses into a worker-readable result.
#
# Honoured for rtsp alone. The statuses are reserved across the whole routines
# script, but no other feature has a cause to express, and an unrelated command
# that happens to exit 20 under `set -e` must not tell an operator that a
# feature with no network policy found no eligible local network.
ROUTINE_EXIT_STATUS_FEATURE = 'rtsp'
ROUTINE_EXIT_CODES = {
    20: 'local-network-unavailable',
    21: 'network-policy-generation-failed',
    22: 'dependency-install-failed',
    23: 'privileged-verification-failed',
}
ROUTINE_FAILURE_CODES = frozenset(ROUTINE_EXIT_CODES.values())
# Causes a root-owned result may carry: the reserved routine causes plus the
# three the helper itself decides. Worker-side causes never reach this wire.
RESULT_FAILURE_CODES = ROUTINE_FAILURE_CODES | frozenset(
    ('request-invalid', 'helper-version-mismatch', 'interrupted'))
O_CLOEXEC = getattr(os, 'O_CLOEXEC', 0)
O_NOFOLLOW = getattr(os, 'O_NOFOLLOW', 0)
PRIVATE_NETWORKS = (
    ipaddress.ip_network('10.0.0.0/8'),
    ipaddress.ip_network('172.16.0.0/12'),
    ipaddress.ip_network('192.168.0.0/16'),
    ipaddress.ip_network('fc00::/7'),
)


class InvalidRequest(ValueError):
    pass


ROOT_BUNDLE_FILES = {
    '/usr/lib/home-worker/feature-installer': 0o755,
    '/usr/lib/home-worker/install-feature-routines': 0o755,
    '/usr/lib/home-worker/live-stream-net-helper': 0o755,
    '/usr/lib/home-worker/live-stream-ffmpeg-runner': 0o755,
    '/usr/lib/home-worker/live-stream-policy-inspector': 0o755,
    '/usr/lib/home-worker/live-view-policy-applier': 0o755,
    '/usr/lib/home-worker/systemd/homeworker-feature-install.service': 0o644,
    '/usr/lib/home-worker/systemd/homeworker-feature-supervisor-restart.service': 0o644,
    '/usr/lib/home-worker/systemd/homeworker-feature-host-reboot.service': 0o644,
    '/usr/lib/home-worker/systemd/homeworker-ffmpeg-stream@.service': 0o644,
    '/usr/lib/home-worker/systemd/homeworker-stream-net.service': 0o644,
    '/usr/lib/home-worker/systemd/homeworker-stream-systemd.rules': 0o644,
    '/usr/lib/home-worker/systemd/homeworker-live-view-policy-apply.service': 0o644,
}


def worker_ids():
    entry = pwd.getpwnam(WORKER_NAME)
    return entry.pw_uid, entry.pw_gid


def _safe_integer(value):
    return (isinstance(value, int) and not isinstance(value, bool)
            and 0 <= value <= 9_007_199_254_740_991)


def _private_network(value):
    if not isinstance(value, str) or not value.strip() or '/' not in value.strip():
        raise ValueError('invalid CIDR')
    network = ipaddress.ip_network(value.strip(), strict=False)
    if not any(network.version == allowed.version and network.subnet_of(allowed)
               for allowed in PRIVATE_NETWORKS):
        raise ValueError('invalid CIDR')
    return network


def _canonical_cidr_values(values):
    if not isinstance(values, list) or len(values) > MAX_ALLOWED_CIDRS:
        raise ValueError('invalid CIDRs')
    networks = {_private_network(value) for value in values}
    if len(networks) > MAX_ALLOWED_CIDRS:
        raise ValueError('invalid CIDRs')
    return [str(network) for network in sorted(
        networks, key=lambda item: (item.version, item.prefixlen, str(item)))]


def legacy_live_view_settings(legacy):
    """Map the two compatibility keys without exposing either value."""
    safe = {
        'version': 1,
        'generation': 0,
        'enabled': False,
        'allowedCameraCidrs': [],
    }
    try:
        if not isinstance(legacy, dict):
            raise ValueError('invalid legacy settings')
        raw_enabled = legacy.get('LIVE_STREAM_ENABLED')
        if raw_enabled is None:
            enabled = False
        elif raw_enabled == 'true':
            enabled = True
        elif raw_enabled == 'false':
            enabled = False
        else:
            raise ValueError('invalid legacy boolean')

        raw_cidrs = legacy.get('RTSP_ALLOWED_CIDRS')
        if raw_cidrs is None or raw_cidrs == '':
            cidrs = []
        elif not isinstance(raw_cidrs, str):
            raise ValueError('invalid legacy CIDRs')
        else:
            entries = [item.strip() for item in raw_cidrs.split(',')]
            if any(not item for item in entries):
                raise ValueError('invalid legacy CIDRs')
            cidrs = _canonical_cidr_values(entries)
        return {
            'settings': {**safe, 'enabled': enabled, 'allowedCameraCidrs': cidrs},
            'attention': None,
        }
    except (TypeError, ValueError):
        return {'settings': safe, 'attention': 'legacy-values-invalid'}


def _read_regular(path, uid, gid, mode, maximum, missing_ok=False):
    try:
        descriptor = os.open(
            path, os.O_RDONLY | os.O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW)
    except FileNotFoundError:
        if missing_ok:
            return None
        raise RuntimeError('settings-state-unsafe')
    except OSError as error:
        raise RuntimeError('settings-state-unsafe') from error
    try:
        value = os.fstat(descriptor)
        if (not stat.S_ISREG(value.st_mode) or value.st_nlink != 1
                or value.st_uid != uid or value.st_gid != gid
                or stat.S_IMODE(value.st_mode) != mode
                or not 1 <= value.st_size <= maximum):
            raise RuntimeError('settings-state-unsafe')
        raw = os.read(descriptor, maximum + 1)
        if len(raw) != value.st_size or len(raw) > maximum:
            raise RuntimeError('settings-state-unsafe')
        return raw
    finally:
        os.close(descriptor)


def _read_legacy_environment(worker_uid, worker_gid):
    try:
        raw = _read_regular(
            WORKER_ENV_PATH, worker_uid, worker_gid, 0o600,
            MAX_ENV_BYTES, missing_ok=True)
    except RuntimeError:
        return None
    if raw is None:
        return {}
    try:
        lines = raw.decode('utf-8', 'strict').splitlines()
    except UnicodeDecodeError:
        return None
    selected = {}
    for line in lines:
        if not line or line.lstrip().startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        key = key.strip()
        if key not in ('LIVE_STREAM_ENABLED', 'RTSP_ALLOWED_CIDRS'):
            continue
        if key in selected:
            return None
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
            value = value[1:-1]
        selected[key] = value
    return selected


def _typed_settings(raw):
    try:
        value = json.loads(raw.decode('utf-8', 'strict'), object_pairs_hook=no_duplicates)
        if (not isinstance(value, dict)
                or set(value) != {'version', 'generation', 'enabled', 'allowedCameraCidrs'}
                or value.get('version') != 1 or isinstance(value.get('version'), bool)
                or not _safe_integer(value.get('generation'))
                or not isinstance(value.get('enabled'), bool)):
            raise ValueError('invalid settings')
        canonical = _canonical_cidr_values(value.get('allowedCameraCidrs'))
        if canonical != value['allowedCameraCidrs']:
            raise ValueError('invalid settings')
        return value
    except (InvalidRequest, RecursionError, TypeError, UnicodeDecodeError,
            ValueError, json.JSONDecodeError) as error:
        raise RuntimeError('settings-state-unsafe') from error


def _existing_typed_settings(worker_gid):
    raw = _read_regular(
        LIVE_VIEW_SETTINGS_PATH, ROOT_UID, worker_gid, 0o640,
        MAX_BYTES, missing_ok=True)
    return None if raw is None else _typed_settings(raw)


def _atomic_path_write(path, payload, uid, gid, mode):
    parent = os.path.dirname(path)
    directory = os.open(
        parent, os.O_RDONLY | os.O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
    temporary = os.path.join(parent, '.%s.%s.tmp' % (
        os.path.basename(path), uuid.uuid4().hex))
    descriptor = None
    try:
        current = os.fstat(directory)
        if (not stat.S_ISDIR(current.st_mode) or current.st_uid != ROOT_UID
                or current.st_gid != ROOT_GID
                or stat.S_IMODE(current.st_mode) & 0o022):
            raise RuntimeError('settings-state-unsafe')
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | O_CLOEXEC | O_NOFOLLOW,
            mode,
        )
        os.fchown(descriptor, uid, gid)
        os.fchmod(descriptor, mode)
        view = memoryview(payload)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                raise OSError('short write')
            view = view[written:]
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = None
        os.replace(temporary, path)
        os.fsync(directory)
    except BaseException:
        if descriptor is not None:
            os.close(descriptor)
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise
    finally:
        os.close(directory)


def _settings_payload(value):
    return (json.dumps(value, separators=(',', ':'), sort_keys=True) + '\n').encode('utf-8')


def _remove_attention_marker(worker_gid):
    raw = _read_regular(
        LIVE_VIEW_ATTENTION_PATH, ROOT_UID, worker_gid, 0o640,
        MAX_BYTES, missing_ok=True)
    if raw is None:
        return
    try:
        value = json.loads(raw.decode('utf-8', 'strict'), object_pairs_hook=no_duplicates)
    except (InvalidRequest, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError('settings-state-unsafe') from error
    if value != {'version': 1, 'code': 'legacy-values-invalid'}:
        raise RuntimeError('settings-state-unsafe')
    directory = os.open(
        os.path.dirname(LIVE_VIEW_ATTENTION_PATH),
        os.O_RDONLY | os.O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW,
    )
    try:
        os.unlink(LIVE_VIEW_ATTENTION_PATH)
        os.fsync(directory)
    finally:
        os.close(directory)


def _attention_marker_present(worker_gid):
    raw = _read_regular(
        LIVE_VIEW_ATTENTION_PATH, ROOT_UID, worker_gid, 0o640,
        MAX_BYTES, missing_ok=True)
    if raw is None:
        return False
    try:
        value = json.loads(
            raw.decode('utf-8', 'strict'), object_pairs_hook=no_duplicates)
    except (InvalidRequest, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError('settings-state-unsafe') from error
    if value != {'version': 1, 'code': 'legacy-values-invalid'}:
        raise RuntimeError('settings-state-unsafe')
    return True


def _credential_environment(worker_uid, worker_gid):
    """Read one exact worker-owned env inode without exposing its contents."""
    try:
        descriptor = os.open(
            WORKER_ENV_PATH,
            os.O_RDONLY | os.O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW,
        )
    except OSError as error:
        raise RuntimeError('rtsp-credentials-unsafe') from error
    try:
        value = os.fstat(descriptor)
        if (not stat.S_ISREG(value.st_mode) or value.st_nlink != 1
                or value.st_uid != worker_uid or value.st_gid != worker_gid
                or stat.S_IMODE(value.st_mode) != 0o600
                or not 1 <= value.st_size <= MAX_ENV_BYTES):
            raise RuntimeError('rtsp-credentials-unsafe')
        raw = os.read(descriptor, MAX_ENV_BYTES + 1)
        if len(raw) != value.st_size or len(raw) > MAX_ENV_BYTES:
            raise RuntimeError('rtsp-credentials-unsafe')
        return raw, (value.st_dev, value.st_ino)
    finally:
        os.close(descriptor)


def _credential_payload(raw):
    try:
        text = raw.decode('utf-8', 'strict')
    except UnicodeDecodeError as error:
        raise RuntimeError('rtsp-credentials-unsafe') from error
    lines = text.splitlines(keepends=True)
    found = None
    value = None
    assignment = re.compile(
        r'^[ \t]*(?:export[ \t]+)?RTSP_CREDENTIALS_KEY[ \t]*=')
    for index, line in enumerate(lines):
        body = line.rstrip('\r\n')
        if not assignment.match(body):
            continue
        if found is not None or not body.startswith('RTSP_CREDENTIALS_KEY='):
            raise RuntimeError('rtsp-credentials-unsafe')
        found = index
        value = body[len('RTSP_CREDENTIALS_KEY='):]
    if value is not None and value != '':
        if re.fullmatch(r'[0-9a-f]{64}', value) is None:
            raise RuntimeError('rtsp-credentials-unsafe')
        return None

    credential = secrets.token_hex(32)
    if re.fullmatch(r'[0-9a-f]{64}', credential) is None:
        raise RuntimeError('rtsp-credentials-unsafe')
    line = 'RTSP_CREDENTIALS_KEY=' + credential + '\n'
    if found is None:
        if text and not text.endswith(('\n', '\r')):
            text += '\n'
        updated = text + line
    else:
        ending = ('\r\n' if lines[found].endswith('\r\n')
                  else '\n' if lines[found].endswith('\n') else '')
        lines[found] = line.rstrip('\n') + ending
        updated = ''.join(lines)
    payload = updated.encode('utf-8')
    if not 1 <= len(payload) <= MAX_ENV_BYTES:
        raise RuntimeError('rtsp-credentials-unsafe')
    return payload


def _replace_credential_environment(payload, worker_uid, worker_gid, identity):
    parent = os.path.dirname(WORKER_ENV_PATH)
    name = os.path.basename(WORKER_ENV_PATH)
    temporary = '.%s.%s.tmp' % (name, uuid.uuid4().hex)
    directory = None
    descriptor = None
    try:
        directory = os.open(
            parent, os.O_RDONLY | os.O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        parent_value = os.fstat(directory)
        if (not stat.S_ISDIR(parent_value.st_mode)
                or parent_value.st_uid not in (ROOT_UID, worker_uid)
                or stat.S_IMODE(parent_value.st_mode) & 0o022):
            raise RuntimeError('rtsp-credentials-unsafe')
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | O_CLOEXEC | O_NOFOLLOW,
            0o600,
            dir_fd=directory,
        )
        os.fchown(descriptor, worker_uid, worker_gid)
        os.fchmod(descriptor, 0o600)
        view = memoryview(payload)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                raise OSError('short write')
            view = view[written:]
        staged = os.fstat(descriptor)
        if (not stat.S_ISREG(staged.st_mode) or staged.st_nlink != 1
                or staged.st_uid != worker_uid or staged.st_gid != worker_gid
                or stat.S_IMODE(staged.st_mode) != 0o600
                or staged.st_size != len(payload)):
            raise RuntimeError('rtsp-credentials-unsafe')
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = None

        current = os.stat(name, dir_fd=directory, follow_symlinks=False)
        if ((current.st_dev, current.st_ino) != identity
                or not stat.S_ISREG(current.st_mode) or current.st_nlink != 1
                or current.st_uid != worker_uid or current.st_gid != worker_gid
                or stat.S_IMODE(current.st_mode) != 0o600):
            raise RuntimeError('rtsp-credentials-unsafe')
        os.replace(
            temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)
    except RuntimeError:
        raise
    except OSError as error:
        raise RuntimeError('rtsp-credentials-unsafe') from error
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if directory is not None:
            try:
                os.unlink(temporary, dir_fd=directory)
                os.fsync(directory)
            except FileNotFoundError:
                pass
            except OSError:
                pass
            os.close(directory)


def provision_rtsp_credentials():
    worker_uid, worker_gid = worker_ids()
    raw, identity = _credential_environment(worker_uid, worker_gid)
    payload = _credential_payload(raw)
    if payload is None:
        return
    _replace_credential_environment(payload, worker_uid, worker_gid, identity)


def run_live_view_reset():
    process = None
    try:
        process = subprocess.Popen(
            [LIVE_VIEW_APPLIER_PATH, '--reset-live-view-settings'],
            cwd='/', env=SAFE_ENV, shell=False, stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True)
        try:
            returncode = process.wait(timeout=LIVE_VIEW_RESET_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired as error:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
            raise RuntimeError('policy-reset-failed') from error
    except RuntimeError:
        raise
    except (OSError, subprocess.SubprocessError) as error:
        if process is not None and process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
        raise RuntimeError('policy-reset-failed') from error
    if returncode != 0:
        raise RuntimeError('policy-reset-failed')


def migrate_live_view_settings():
    """Create generation zero once without replacing typed authority."""
    _worker_uid, worker_gid = worker_ids()
    existing = _existing_typed_settings(worker_gid)
    if existing is not None:
        return {'status': 'preserved', 'settings': existing, 'attention': None}
    marker_present = _attention_marker_present(worker_gid)

    legacy = _read_legacy_environment(_worker_uid, worker_gid)
    migrated = legacy_live_view_settings(legacy if legacy is not None else object())
    if migrated['attention'] is not None:
        marker = b'{"version":1,"code":"legacy-values-invalid"}\n'
        _atomic_path_write(
            LIVE_VIEW_ATTENTION_PATH, marker, ROOT_UID, worker_gid, 0o640)
    _atomic_path_write(
        LIVE_VIEW_SETTINGS_PATH, _settings_payload(migrated['settings']),
        ROOT_UID, worker_gid, 0o640)
    if migrated['attention'] is None and marker_present:
        _remove_attention_marker(worker_gid)
    return {'status': 'created', **migrated}


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
    for bundled, active in (
            (STREAM_NET_BUNDLED_UNIT_PATH, STREAM_NET_ACTIVE_UNIT_PATH),
            (LIVE_VIEW_BUNDLED_UNIT_PATH, LIVE_VIEW_ACTIVE_UNIT_PATH)):
        if not root_owned_file(active, 0o644):
            raise RuntimeError('helper-version-mismatch')
        try:
            if file_digest(active) != file_digest(bundled):
                raise RuntimeError('helper-version-mismatch')
        except OSError as error:
            raise RuntimeError('helper-version-mismatch') from error


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
        if (value['failureCode'] not in RESULT_FAILURE_CODES
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
        return 'dependency-install-failed'
    try:
        status = process.wait(timeout=TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
        return 'interrupted'
    if status == 0:
        return 'ok'
    if feature != ROUTINE_EXIT_STATUS_FEATURE:
        return 'dependency-install-failed'
    return ROUTINE_EXIT_CODES.get(status, 'dependency-install-failed')


def verify_feature(feature):
    commands = {
        # gpiod era: the CLI tools we actually spawn must exist, and a bare
        # gpiodetect must enumerate a chip (the runtime check that replaces
        # `pigs t`). No pigpiod service check — install-feature.sh masks it.
        'digital': (('/usr/bin/which', 'gpiodetect'), ('/usr/bin/which', 'gpiomon'), ('/usr/bin/gpiodetect',)),
        'uart': (('/usr/bin/test', '-e', '/dev/serial0'),),
        'zigbee': (('/usr/bin/which', 'mosquitto'), ('/bin/systemctl', 'is-active', '--quiet', 'mosquitto.service')),
        'motion': (('/usr/bin/which', 'motion'), ('/usr/bin/which', 'ffmpeg'), ('/usr/bin/test', '-f', '/etc/motion/motion.conf'), ('/usr/bin/test', '-d', '/home/pi/motion/videos'), ('/bin/systemctl', 'is-active', '--quiet', 'motion.service')),
        'rtsp': (('/usr/bin/which', 'ffmpeg'), ('/usr/bin/which', 'cloudflared'),
                 ('/usr/bin/test', '-f', STREAM_NET_ACTIVE_UNIT_PATH),
                 ('/bin/systemctl', 'is-active', '--quiet', 'homeworker-stream-net.service')),
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
            return (owned_regular(STREAM_NET_ACTIVE_UNIT_PATH, 0, 0, 0o644)
                    and rtsp_policy_installed())
        return True
    except (OSError, subprocess.TimeoutExpired):
        return False


def owned_regular(path, uid, gid, mode):
    value = os.stat(path, follow_symlinks=False)
    return (stat.S_ISREG(value.st_mode) and value.st_nlink == 1 and value.st_uid == uid
            and value.st_gid == gid and stat.S_IMODE(value.st_mode) == mode)


def read_owned_regular(path, uid, gid, mode, limit):
    """Bounded contents of a no-follow, single-link file with the exact owner and mode."""
    try:
        fd = os.open(path, os.O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
    except OSError:
        return None
    try:
        value = os.fstat(fd)
        if (not stat.S_ISREG(value.st_mode) or value.st_nlink != 1 or value.st_uid != uid
                or (gid is not None and value.st_gid != gid)
                or stat.S_IMODE(value.st_mode) != mode):
            return None
        raw = os.read(fd, limit + 1)
    except OSError:
        return None
    finally:
        os.close(fd)
    return None if len(raw) > limit else raw


def load_live_view_applier():
    """Load the manifest-validated v2 policy authority from the root bundle."""
    loader = importlib.machinery.SourceFileLoader(
        'live_view_policy_applier', LIVE_VIEW_APPLIER_PATH)
    module = importlib.util.module_from_spec(
        importlib.util.spec_from_loader(loader.name, loader))
    loader.exec_module(module)
    return module


def journal_rtsp_rejection(reason):
    """Log one closed token, never policy, settings, or environment values."""
    try:
        syslog.openlog(
            'home-worker-feature-installer', syslog.LOG_PID, syslog.LOG_DAEMON)
        syslog.syslog(syslog.LOG_ERR, 'rtsp-policy-rejected: ' + reason)
    except Exception:
        return


def rtsp_policy_rejection():
    """Verify the deny-all bootstrap tuple through the single v2 authority."""
    try:
        applier = load_live_view_applier()
        _worker_uid, worker_gid = worker_ids()
        settings = applier.read_settings(worker_gid)
        installed = applier.read_installed_policy()
        expected = applier.policy_for(settings, False)
    except (KeyError, OSError, RuntimeError, SyntaxError, ValueError):
        return 'policy-state-invalid'
    if installed != expected:
        return 'policy-tuple-mismatch'
    return None


def rtsp_policy_installed():
    """Fail closed and publish only a bounded rejection token to root's log."""
    try:
        reason = rtsp_policy_rejection()
    except Exception:
        reason = 'unexpected'
    if reason is None:
        return True
    journal_rtsp_rejection(reason)
    return False


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
        routine_outcome = run_routine(request['feature'])
        verification_ok = verify_feature(request['feature'])
        if routine_outcome == 'ok' and verification_ok:
            payload = result_payload(request, 'succeeded')
        elif routine_outcome == 'interrupted':
            payload = result_payload(request, 'failed', 'interrupted')
        elif routine_outcome != 'ok':
            # Only the reserved causes survive; anything else is a dependency failure.
            payload = result_payload(request, 'failed', routine_outcome
                                     if routine_outcome in ROUTINE_FAILURE_CODES
                                     else 'dependency-install-failed')
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
    if len(sys.argv) == 2 and sys.argv[1] == '--provision-rtsp-credentials':
        if os.geteuid() != ROOT_UID:
            return 1
        try:
            validate_root_bundle()
            provision_rtsp_credentials()
            return 0
        except (OSError, RuntimeError, ValueError):
            return 5
    if len(sys.argv) == 2 and sys.argv[1] in (
            '--migrate-live-view-settings', '--reset-live-view-settings'):
        try:
            validate_root_bundle()
            if sys.argv[1] == '--reset-live-view-settings':
                run_live_view_reset()
            else:
                migrate_live_view_settings()
            return 0
        except (OSError, RuntimeError, ValueError):
            return 5
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
