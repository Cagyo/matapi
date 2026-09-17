#!/usr/bin/python3
"""Root-only, fixed-schema live-view settings and RTSP policy applier.

Every production location, command, account, mode, and unit is a constant.
The worker can publish bounded requests and zero-byte acknowledgements, but it
cannot select a path or command and never receives privileged command output.
"""

import fcntl
import hashlib
import importlib.machinery
import importlib.util
import ipaddress
import json
import os
import pwd
import re
import stat
import subprocess
import sys
import uuid


INSTALL_ROOT = "/var/lib/home-worker"
SETTINGS_PATH = INSTALL_ROOT + "/live-view-settings.json"
ATTENTION_PATH = INSTALL_ROOT + "/live-view-settings-migration-attention.json"
REQUEST_DIRECTORY = INSTALL_ROOT + "/live-view-settings-requests"
CLAIM_DIRECTORY = INSTALL_ROOT + "/live-view-settings-claims"
RESULT_DIRECTORY = INSTALL_ROOT + "/live-view-settings-results"
ACK_DIRECTORY = INSTALL_ROOT + "/live-view-settings-acks"
POLICY_DIRECTORY = "/etc/home-worker"
POLICY_PATH = POLICY_DIRECTORY + "/live-stream-policy.json"
SUMMARY_PATH = POLICY_DIRECTORY + "/live-stream-policy.summary.json"
LOCK_PATH = "/run/lock/homeworker-live-view-policy.lock"

APPLIER_PATH = "/usr/lib/home-worker/live-view-policy-applier"
NET_HELPER_PATH = "/usr/lib/home-worker/live-stream-net-helper"
POLICY_INSPECTOR_PATH = "/usr/lib/home-worker/live-stream-policy-inspector"
BUNDLED_UNIT_PATH = (
    "/usr/lib/home-worker/systemd/homeworker-live-view-policy-apply.service"
)
ACTIVE_UNIT_PATH = "/etc/systemd/system/homeworker-live-view-policy-apply.service"
STREAM_NET_UNIT_PATH = "/etc/systemd/system/homeworker-stream-net.service"
VERSION_PATH = "/usr/lib/home-worker/feature-installer.version"
MANIFEST_PATH = "/usr/lib/home-worker/feature-installer.manifest"
WORKER_ENV_PATH = "/opt/home-worker/.env"

APPLIER_VERSION = "8"
WORKER_NAME = "homeworker"
STREAM_NAME = "homeworker-stream"
SYSTEMCTL = "/bin/systemctl"
STREAM_NET_UNIT = "homeworker-stream-net.service"
SAFE_ENV = {
    "PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
    "LANG": "C",
    "LC_ALL": "C",
}

ROOT_UID = 0
ROOT_GID = 0
INSTALL_ROOT_MODE = 0o711
MAX_BYTES = 4096
MAX_ENV_BYTES = 64 * 1024
MAX_SAFE_INTEGER = 9_007_199_254_740_991
MAX_ALLOWED_CIDRS = 16
MAX_UDP_PORTS = 64
COMMAND_TIMEOUT_SECONDS = 15
RTSP_ASSETS_ABSENT = "absent"
RTSP_ASSETS_VALID = "valid"
RTSP_ASSETS_UNSAFE = "unsafe"
REQUEST_ID = re.compile(r"^[A-Za-z0-9_-]{16}$")
REQUEST_ENTRY = re.compile(r"^([A-Za-z0-9_-]{16})\.json$")
ACK_ENTRY = re.compile(r"^([A-Za-z0-9_-]{16})\.ack$")
DIGEST = re.compile(r"^[0-9a-f]{64}$")
FAILURE_CODES = frozenset(
    (
        "request-invalid",
        "stale-generation",
        "settings-state-unsafe",
        "policy-apply-failed",
        "service-unhealthy",
        "rtsp-assets-absent",
        "interrupted",
        "helper-version-mismatch",
    )
)
PRIVATE_NETWORKS = (
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("fc00::/7"),
)
O_CLOEXEC = getattr(os, "O_CLOEXEC", 0)
O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)


class InvalidRequest(ValueError):
    """A request/result cannot cross the privileged wire boundary."""

    def __init__(self, message, identity=None):
        super().__init__(message)
        self.identity = identity


class ApplyFailure(RuntimeError):
    """One closed terminal failure code, never raw privileged detail."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


def worker_ids():
    entry = pwd.getpwnam(WORKER_NAME)
    return entry.pw_uid, entry.pw_gid


def is_integer(value, minimum=0, maximum=MAX_SAFE_INTEGER):
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and minimum <= value <= maximum
    )


def no_duplicates(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise InvalidRequest("duplicate key")
        value[key] = item
    return value


def strict_json(data, label="JSON"):
    if not isinstance(data, (bytes, bytearray)) or not 1 <= len(data) <= MAX_BYTES:
        raise InvalidRequest("invalid " + label)
    try:
        return json.loads(bytes(data).decode("utf-8", "strict"), object_pairs_hook=no_duplicates)
    except (
        UnicodeDecodeError,
        json.JSONDecodeError,
        InvalidRequest,
        RecursionError,
    ) as error:
        raise InvalidRequest("invalid " + label) from error


def private_network(text, normalize):
    if not isinstance(text, str) or not text.strip() or "/" not in text.strip():
        raise InvalidRequest("CIDR")
    candidate = text.strip()
    try:
        network = ipaddress.ip_network(candidate, strict=not normalize)
    except ValueError as error:
        raise InvalidRequest("CIDR") from error
    if (
        network.prefixlen == 0
        or network.is_loopback
        or network.is_link_local
        or network.is_multicast
        or network.is_unspecified
        or network.is_global
    ):
        raise InvalidRequest("CIDR")
    if not any(
        network.version == allowed.version and network.subnet_of(allowed)
        for allowed in PRIVATE_NETWORKS
    ):
        raise InvalidRequest("CIDR")
    if not normalize and str(network) != candidate:
        raise InvalidRequest("CIDR")
    return network


def canonical_cidrs(value):
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise InvalidRequest("CIDRs")
    networks = {private_network(item, True) for item in value}
    if len(networks) > MAX_ALLOWED_CIDRS:
        raise InvalidRequest("CIDRs")
    return [
        str(network)
        for network in sorted(
            networks,
            key=lambda item: (item.version, item.prefixlen, str(item)),
        )
    ]


def parse_candidate(value):
    if (
        not isinstance(value, dict)
        or set(value) != {"enabled", "allowedCameraCidrs"}
        or not isinstance(value.get("enabled"), bool)
    ):
        raise InvalidRequest("settings candidate")
    return {
        "enabled": value["enabled"],
        "allowedCameraCidrs": canonical_cidrs(value["allowedCameraCidrs"]),
    }


def parse_settings(data):
    value = strict_json(data, "settings")
    if (
        not isinstance(value, dict)
        or set(value)
        != {"version", "generation", "enabled", "allowedCameraCidrs"}
        or value.get("version") != 1
        or isinstance(value.get("version"), bool)
        or not is_integer(value.get("generation"))
    ):
        raise InvalidRequest("settings schema")
    candidate = parse_candidate(
        {
            "enabled": value["enabled"],
            "allowedCameraCidrs": value["allowedCameraCidrs"],
        }
    )
    return {"version": 1, "generation": value["generation"], **candidate}


def request_identity(value, filename):
    if not isinstance(value, dict):
        return None
    request_id = value.get("requestId")
    kind = value.get("kind")
    matched = REQUEST_ENTRY.fullmatch(filename)
    if (
        not isinstance(request_id, str)
        or REQUEST_ID.fullmatch(request_id) is None
        or matched is None
        or matched.group(1) != request_id
        or kind not in ("settings-mutation", "rtsp-state-reconcile")
    ):
        return None
    return {"requestId": request_id, "kind": kind}


def parse_request(data, filename):
    value = strict_json(data, "request")
    identity = request_identity(value, filename)
    if identity is None:
        raise InvalidRequest("request identity")
    common = (
        value.get("version") == 1
        and not isinstance(value.get("version"), bool)
        and is_integer(value.get("expectedGeneration"))
        and isinstance(value.get("rtspEnabled"), bool)
    )
    if not common:
        raise InvalidRequest("request schema", identity)
    if value["kind"] == "settings-mutation":
        if set(value) != {
            "version",
            "kind",
            "requestId",
            "expectedGeneration",
            "rtspEnabled",
            "settings",
        }:
            raise InvalidRequest("request schema", identity)
        try:
            candidate = parse_candidate(value["settings"])
        except InvalidRequest as error:
            raise InvalidRequest("request settings", identity) from error
        return {
            "version": 1,
            "kind": "settings-mutation",
            "requestId": value["requestId"],
            "expectedGeneration": value["expectedGeneration"],
            "rtspEnabled": value["rtspEnabled"],
            "settings": candidate,
        }
    if set(value) != {
        "version",
        "kind",
        "requestId",
        "expectedGeneration",
        "rtspEnabled",
    }:
        raise InvalidRequest("request schema", identity)
    return {
        "version": 1,
        "kind": "rtsp-state-reconcile",
        "requestId": value["requestId"],
        "expectedGeneration": value["expectedGeneration"],
        "rtspEnabled": value["rtspEnabled"],
    }


def canonical_json(value):
    return (
        json.dumps(value, separators=(",", ":"), sort_keys=True) + "\n"
    ).encode("utf-8")


def parse_policy(data):
    value = strict_json(data, "policy")
    expected = {
        "version",
        "settingsGeneration",
        "rtspEnabled",
        "workerUid",
        "streamUid",
        "allowedCidrs",
        "udpPortFirst",
        "udpPortLast",
    }
    if (
        not isinstance(value, dict)
        or set(value) != expected
        or value.get("version") != 2
        or isinstance(value.get("version"), bool)
        or not is_integer(value.get("settingsGeneration"))
        or not isinstance(value.get("rtspEnabled"), bool)
        or not is_integer(value.get("workerUid"))
        or not is_integer(value.get("streamUid"))
        or value.get("workerUid") == value.get("streamUid")
        or not is_integer(value.get("udpPortFirst"), 1024, 65535)
        or not is_integer(value.get("udpPortLast"), 1024, 65535)
        or value["udpPortFirst"] > value["udpPortLast"]
        or value["udpPortLast"] - value["udpPortFirst"] + 1 > MAX_UDP_PORTS
    ):
        raise InvalidRequest("policy schema")
    cidrs = canonical_cidrs(value["allowedCidrs"])
    if cidrs != value["allowedCidrs"]:
        raise InvalidRequest("policy order")
    if not value["rtspEnabled"] and cidrs:
        raise InvalidRequest("disabled policy grants")
    return {**value, "allowedCidrs": cidrs}


def parse_result(data, request_id=None, kind=None):
    value = strict_json(data, "result")
    if (
        not isinstance(value, dict)
        or set(value)
        != {
            "version",
            "kind",
            "requestId",
            "outcome",
            "resultingGeneration",
            "resultingRtspEnabled",
            "failureCode",
        }
        or value.get("version") != 1
        or isinstance(value.get("version"), bool)
        or value.get("kind") not in ("settings-mutation", "rtsp-state-reconcile")
        or not isinstance(value.get("requestId"), str)
        or REQUEST_ID.fullmatch(value["requestId"]) is None
        or (request_id is not None and value["requestId"] != request_id)
        or (kind is not None and value["kind"] != kind)
    ):
        raise InvalidRequest("result schema")
    if value["outcome"] == "succeeded":
        if (
            not is_integer(value["resultingGeneration"])
            or not isinstance(value["resultingRtspEnabled"], bool)
            or value["failureCode"] is not None
        ):
            raise InvalidRequest("result success")
    elif value["outcome"] == "failed":
        if (
            value["resultingGeneration"] is not None
            or value["resultingRtspEnabled"] is not None
            or value["failureCode"] not in FAILURE_CODES
        ):
            raise InvalidRequest("result failure")
    else:
        raise InvalidRequest("result outcome")
    return value


def result_payload(request, outcome, failure=None, generation=None, rtsp_enabled=None):
    if outcome == "succeeded":
        value = {
            "version": 1,
            "kind": request["kind"],
            "requestId": request["requestId"],
            "outcome": "succeeded",
            "resultingGeneration": generation,
            "resultingRtspEnabled": rtsp_enabled,
            "failureCode": None,
        }
    else:
        value = {
            "version": 1,
            "kind": request["kind"],
            "requestId": request["requestId"],
            "outcome": "failed",
            "resultingGeneration": None,
            "resultingRtspEnabled": None,
            "failureCode": failure,
        }
    parse_result(canonical_json(value), request["requestId"], request["kind"])
    return value


def file_digest(path):
    descriptor = os.open(path, os.O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
    try:
        digest = hashlib.sha256()
        while True:
            chunk = os.read(descriptor, 65536)
            if not chunk:
                return digest.hexdigest()
            digest.update(chunk)
    finally:
        os.close(descriptor)


def root_owned_file(path, mode):
    try:
        value = os.stat(path, follow_symlinks=False)
    except OSError:
        return False
    return (
        stat.S_ISREG(value.st_mode)
        and value.st_nlink == 1
        and value.st_uid == ROOT_UID
        and value.st_gid == ROOT_GID
        and stat.S_IMODE(value.st_mode) == mode
    )


def read_path_checked(path, uid, gid, mode, maximum):
    descriptor = os.open(
        path, os.O_RDONLY | os.O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW
    )
    try:
        value = os.fstat(descriptor)
        if (
            not stat.S_ISREG(value.st_mode)
            or value.st_nlink != 1
            or value.st_uid != uid
            or (gid is not None and value.st_gid != gid)
            or stat.S_IMODE(value.st_mode) != mode
            or not 1 <= value.st_size <= maximum
        ):
            raise InvalidRequest("unsafe file")
        data = os.read(descriptor, maximum + 1)
        if len(data) != value.st_size or len(data) > maximum:
            raise InvalidRequest("file changed")
        return data
    finally:
        os.close(descriptor)


def validate_root_bundle():
    required = {
        APPLIER_PATH: 0o755,
        NET_HELPER_PATH: 0o755,
        POLICY_INSPECTOR_PATH: 0o755,
        BUNDLED_UNIT_PATH: 0o644,
    }
    if (
        not root_owned_file(VERSION_PATH, 0o644)
        or not root_owned_file(MANIFEST_PATH, 0o644)
        or not root_owned_file(ACTIVE_UNIT_PATH, 0o644)
    ):
        raise RuntimeError("helper-version-mismatch")
    try:
        version = read_path_checked(
            VERSION_PATH, ROOT_UID, ROOT_GID, 0o644, MAX_BYTES
        ).decode("ascii", "strict")
        manifest = read_path_checked(
            MANIFEST_PATH, ROOT_UID, ROOT_GID, 0o644, MAX_ENV_BYTES
        ).decode("ascii", "strict")
    except (OSError, UnicodeError, InvalidRequest) as error:
        raise RuntimeError("helper-version-mismatch") from error
    if version != APPLIER_VERSION + "\n":
        raise RuntimeError("helper-version-mismatch")
    lines = manifest.splitlines()
    if not lines or lines[0] != "version " + APPLIER_VERSION:
        raise RuntimeError("helper-version-mismatch")
    entries = {}
    for line in lines[1:]:
        pieces = line.split(" ", 2)
        if (
            len(pieces) != 3
            or DIGEST.fullmatch(pieces[0]) is None
            or re.fullmatch(r"[0-7]{4}", pieces[1]) is None
            or not pieces[2].startswith("/")
            or pieces[2] in entries
        ):
            raise RuntimeError("helper-version-mismatch")
        entries[pieces[2]] = (pieces[0], pieces[1])
    for path, mode in required.items():
        try:
            expected = (
                (file_digest(path), format(mode, "04o"))
                if root_owned_file(path, mode)
                else None
            )
        except OSError as error:
            raise RuntimeError("helper-version-mismatch") from error
        if expected is None or entries.get(path) != expected:
            raise RuntimeError("helper-version-mismatch")
    try:
        if file_digest(ACTIVE_UNIT_PATH) != file_digest(BUNDLED_UNIT_PATH):
            raise RuntimeError("helper-version-mismatch")
    except OSError as error:
        raise RuntimeError("helper-version-mismatch") from error


def validate_directory_metadata(value, uid, gid, mode):
    if (
        not stat.S_ISDIR(value.st_mode)
        or value.st_uid != uid
        or value.st_gid != gid
        or stat.S_IMODE(value.st_mode) != mode
    ):
        raise RuntimeError("unsafe directory")


def directory_fd(path, uid, gid, mode):
    descriptor = os.open(
        path, os.O_RDONLY | os.O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW
    )
    try:
        validate_directory_metadata(os.fstat(descriptor), uid, gid, mode)
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def validate_parent_chain(path):
    if not os.path.isabs(path):
        raise RuntimeError("unsafe parent")
    descriptor = os.open(
        "/", os.O_RDONLY | os.O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW
    )
    try:
        root = os.fstat(descriptor)
        if (
            not stat.S_ISDIR(root.st_mode)
            or root.st_uid != ROOT_UID
            or stat.S_IMODE(root.st_mode) & 0o022
        ):
            raise RuntimeError("unsafe parent")
        components = [item for item in path.split("/") if item]
        for component in components:
            following = os.open(
                component,
                os.O_RDONLY | os.O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW,
                dir_fd=descriptor,
            )
            os.close(descriptor)
            descriptor = following
            value = os.fstat(descriptor)
            mode = stat.S_IMODE(value.st_mode)
            if (
                not stat.S_ISDIR(value.st_mode)
                or value.st_uid != ROOT_UID
                or (mode & 0o002)
                or ((mode & 0o020) and value.st_gid != ROOT_GID)
            ):
                raise RuntimeError("unsafe parent")
    finally:
        os.close(descriptor)


def validate_fixed_parents():
    for path in (
        INSTALL_ROOT,
        REQUEST_DIRECTORY,
        CLAIM_DIRECTORY,
        RESULT_DIRECTORY,
        ACK_DIRECTORY,
        POLICY_DIRECTORY,
        LOCK_PATH,
        APPLIER_PATH,
        NET_HELPER_PATH,
        BUNDLED_UNIT_PATH,
        ACTIVE_UNIT_PATH,
        STREAM_NET_UNIT_PATH,
        VERSION_PATH,
        MANIFEST_PATH,
    ):
        validate_parent_chain(os.path.dirname(path))


def validate_layout(worker_uid, worker_gid):
    del worker_uid
    expected = (
        (INSTALL_ROOT, ROOT_UID, ROOT_GID, INSTALL_ROOT_MODE),
        (REQUEST_DIRECTORY, ROOT_UID, worker_gid, 0o770),
        (CLAIM_DIRECTORY, ROOT_UID, ROOT_GID, 0o700),
        (RESULT_DIRECTORY, ROOT_UID, worker_gid, 0o750),
        (ACK_DIRECTORY, ROOT_UID, worker_gid, 0o770),
        (POLICY_DIRECTORY, ROOT_UID, ROOT_GID, 0o755),
    )
    for path, uid, gid, mode in expected:
        descriptor = directory_fd(path, uid, gid, mode)
        os.close(descriptor)


def lock_applier():
    validate_parent_chain(os.path.dirname(LOCK_PATH))
    descriptor = os.open(
        LOCK_PATH,
        os.O_RDWR | os.O_CREAT | O_CLOEXEC | O_NOFOLLOW,
        0o600,
    )
    try:
        value = os.fstat(descriptor)
        if (
            not stat.S_ISREG(value.st_mode)
            or value.st_nlink != 1
            or value.st_uid != ROOT_UID
            or value.st_gid != ROOT_GID
            or stat.S_IMODE(value.st_mode) != 0o600
        ):
            raise RuntimeError("unsafe policy lock")
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def fsync_directory(descriptor):
    os.fsync(descriptor)


def matching_entries(descriptor, pattern):
    return sorted(name for name in os.listdir(descriptor) if pattern.fullmatch(name))


def claim_next(request_fd, claim_fd):
    claims = matching_entries(claim_fd, REQUEST_ENTRY)
    if claims:
        return claims[0]
    for name in matching_entries(request_fd, REQUEST_ENTRY):
        try:
            os.rename(name, name, src_dir_fd=request_fd, dst_dir_fd=claim_fd)
            fsync_directory(claim_fd)
            fsync_directory(request_fd)
            return name
        except FileNotFoundError:
            continue
        except FileExistsError:
            continue
    return None


def read_descriptor(descriptor, metadata, maximum, allow_empty=False):
    minimum = 0 if allow_empty else 1
    if not minimum <= metadata.st_size <= maximum:
        raise InvalidRequest("unsafe size")
    data = os.read(descriptor, maximum + 1)
    if len(data) != metadata.st_size or len(data) > maximum:
        raise InvalidRequest("file changed")
    return data


def claim_replay_state(metadata, worker_uid, worker_gid):
    """Return whether ownership proves the claim crossed an earlier run."""
    if metadata.st_uid == ROOT_UID and metadata.st_gid == ROOT_GID:
        return True
    if metadata.st_uid == worker_uid and metadata.st_gid == worker_gid:
        return False
    raise InvalidRequest("unsafe claim owner")


def validate_claim_metadata(metadata, worker_uid, worker_gid):
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_nlink != 1
        or stat.S_IMODE(metadata.st_mode) != 0o600
    ):
        raise InvalidRequest("unsafe claim")
    return claim_replay_state(metadata, worker_uid, worker_gid)


def open_claim(claim_fd, name, worker_uid, worker_gid):
    try:
        descriptor = os.open(
            name,
            os.O_RDONLY | os.O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW,
            dir_fd=claim_fd,
        )
    except OSError as error:
        # O_NOFOLLOW refuses symlinks before a descriptor exists. A
        # descriptor-relative lstat distinguishes that attacker-controlled
        # entry from a transient failure opening otherwise-safe metadata.
        try:
            metadata = os.stat(name, dir_fd=claim_fd, follow_symlinks=False)
            validate_claim_metadata(metadata, worker_uid, worker_gid)
        except InvalidRequest as invalid:
            raise invalid from error
        except OSError:
            pass
        raise
    try:
        value = os.fstat(descriptor)
        replay = validate_claim_metadata(value, worker_uid, worker_gid)
        return read_descriptor(descriptor, value, MAX_BYTES), replay
    finally:
        os.close(descriptor)


def open_entry(directory_descriptor, name, uid, gid, mode, maximum, allow_empty=False):
    descriptor = os.open(
        name,
        os.O_RDONLY | os.O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW,
        dir_fd=directory_descriptor,
    )
    try:
        value = os.fstat(descriptor)
        if (
            not stat.S_ISREG(value.st_mode)
            or value.st_nlink != 1
            or value.st_uid != uid
            or value.st_gid != gid
            or stat.S_IMODE(value.st_mode) != mode
        ):
            raise InvalidRequest("unsafe entry")
        return read_descriptor(descriptor, value, maximum, allow_empty)
    finally:
        os.close(descriptor)


def remove_entry(directory_descriptor, name):
    try:
        os.unlink(name, dir_fd=directory_descriptor)
    except FileNotFoundError:
        return
    fsync_directory(directory_descriptor)


def quarantine_claim(claim_fd, name):
    """Move unsafe claim metadata out of the lexical work queue without deletion."""
    quarantine = ".unsafe-" + uuid.uuid4().hex
    os.rename(
        name,
        quarantine,
        src_dir_fd=claim_fd,
        dst_dir_fd=claim_fd,
    )
    fsync_directory(claim_fd)


def write_atomic(directory_descriptor, name, payload, uid, gid, mode):
    temporary = ".%s.%s.tmp" % (name, uuid.uuid4().hex)
    try:
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | O_CLOEXEC | O_NOFOLLOW,
            mode,
            dir_fd=directory_descriptor,
        )
        try:
            os.fchown(descriptor, uid, gid)
            os.fchmod(descriptor, mode)
            view = memoryview(payload)
            while view:
                written = os.write(descriptor, view)
                if written <= 0:
                    raise OSError("short write")
                view = view[written:]
            value = os.fstat(descriptor)
            if (
                not stat.S_ISREG(value.st_mode)
                or value.st_nlink != 1
                or value.st_uid != uid
                or value.st_gid != gid
                or stat.S_IMODE(value.st_mode) != mode
                or value.st_size != len(payload)
            ):
                raise OSError("unsafe staged file")
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.replace(
            temporary,
            name,
            src_dir_fd=directory_descriptor,
            dst_dir_fd=directory_descriptor,
        )
        fsync_directory(directory_descriptor)
    except BaseException:
        try:
            os.unlink(temporary, dir_fd=directory_descriptor)
            fsync_directory(directory_descriptor)
        except OSError:
            pass
        raise


def seal_claim(claim_fd, name, request):
    """Replace an accepted worker inode with immutable canonical replay evidence."""
    write_atomic(
        claim_fd,
        name,
        canonical_json(request),
        ROOT_UID,
        ROOT_GID,
        0o600,
    )


def read_settings(worker_gid):
    descriptor = directory_fd(
        INSTALL_ROOT, ROOT_UID, ROOT_GID, INSTALL_ROOT_MODE
    )
    try:
        data = open_entry(
            descriptor,
            os.path.basename(SETTINGS_PATH),
            ROOT_UID,
            worker_gid,
            0o640,
            MAX_BYTES,
        )
        return parse_settings(data)
    except (OSError, InvalidRequest) as error:
        raise ApplyFailure("settings-state-unsafe") from error
    finally:
        os.close(descriptor)


def write_settings_atomic(value, worker_gid):
    payload = canonical_json(value)
    parse_settings(payload)
    descriptor = directory_fd(
        INSTALL_ROOT, ROOT_UID, ROOT_GID, INSTALL_ROOT_MODE
    )
    try:
        write_atomic(
            descriptor,
            os.path.basename(SETTINGS_PATH),
            payload,
            ROOT_UID,
            worker_gid,
            0o640,
        )
    finally:
        os.close(descriptor)


def read_attention_marker(worker_gid):
    descriptor = directory_fd(
        INSTALL_ROOT, ROOT_UID, ROOT_GID, INSTALL_ROOT_MODE
    )
    name = os.path.basename(ATTENTION_PATH)
    try:
        try:
            data = open_entry(
                descriptor, name, ROOT_UID, worker_gid, 0o640, MAX_BYTES
            )
        except FileNotFoundError:
            return False
        value = strict_json(data, "attention marker")
        if (
            not isinstance(value, dict)
            or set(value) != {"version", "code"}
            or value.get("version") != 1
            or isinstance(value.get("version"), bool)
            or value.get("code") != "legacy-values-invalid"
        ):
            raise InvalidRequest("attention marker")
        return True
    except (OSError, InvalidRequest) as error:
        raise ApplyFailure("settings-state-unsafe") from error
    finally:
        os.close(descriptor)


def remove_attention_marker():
    _worker_uid, worker_gid = worker_ids()
    descriptor = directory_fd(
        INSTALL_ROOT, ROOT_UID, ROOT_GID, INSTALL_ROOT_MODE
    )
    name = os.path.basename(ATTENTION_PATH)
    try:
        try:
            data = open_entry(
                descriptor, name, ROOT_UID, worker_gid, 0o640, MAX_BYTES
            )
        except FileNotFoundError:
            return
        value = strict_json(data, "attention marker")
        if (
            not isinstance(value, dict)
            or set(value) != {"version", "code"}
            or value.get("version") != 1
            or isinstance(value.get("version"), bool)
            or value.get("code") != "legacy-values-invalid"
        ):
            raise InvalidRequest("attention marker")
        remove_entry(descriptor, name)
    finally:
        os.close(descriptor)


def reset_attention_marker_identity(worker_gid):
    """Accept any bounded safe marker inode; reset repairs its payload."""
    descriptor = directory_fd(
        INSTALL_ROOT, ROOT_UID, ROOT_GID, INSTALL_ROOT_MODE
    )
    name = os.path.basename(ATTENTION_PATH)
    marker = None
    try:
        try:
            marker = os.open(
                name,
                os.O_RDONLY | os.O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW,
                dir_fd=descriptor,
            )
        except FileNotFoundError:
            return None
        value = os.fstat(marker)
        if (
            not stat.S_ISREG(value.st_mode)
            or value.st_nlink != 1
            or value.st_uid != ROOT_UID
            or value.st_gid != worker_gid
            or stat.S_IMODE(value.st_mode) != 0o640
            or not 1 <= value.st_size <= MAX_BYTES
        ):
            raise InvalidRequest("attention marker")
        return value.st_dev, value.st_ino
    except (OSError, InvalidRequest) as error:
        raise ApplyFailure("settings-state-unsafe") from error
    finally:
        if marker is not None:
            os.close(marker)
        os.close(descriptor)


def remove_reset_attention_marker(identity, worker_gid):
    """Remove only the same safe fixed-name marker inspected before reset."""
    if identity is None:
        return
    descriptor = directory_fd(
        INSTALL_ROOT, ROOT_UID, ROOT_GID, INSTALL_ROOT_MODE
    )
    name = os.path.basename(ATTENTION_PATH)
    try:
        try:
            value = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
        except FileNotFoundError:
            return
        if (
            (value.st_dev, value.st_ino) != identity
            or not stat.S_ISREG(value.st_mode)
            or value.st_nlink != 1
            or value.st_uid != ROOT_UID
            or value.st_gid != worker_gid
            or stat.S_IMODE(value.st_mode) != 0o640
            or not 1 <= value.st_size <= MAX_BYTES
        ):
            raise ApplyFailure("settings-state-unsafe")
        remove_entry(descriptor, name)
    finally:
        os.close(descriptor)


def parse_environment(data):
    try:
        lines = data.decode("utf-8", "strict").splitlines()
    except UnicodeDecodeError as error:
        raise ApplyFailure("policy-apply-failed") from error
    values = {}
    for line in lines:
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, raw = line.split("=", 1)
        if key in values:
            raise ApplyFailure("policy-apply-failed")
        values[key] = raw.strip().strip('"').strip("'")
    return values


def policy_runtime_values():
    try:
        worker = pwd.getpwnam(WORKER_NAME)
        stream = pwd.getpwnam(STREAM_NAME)
        raw = read_path_checked(
            WORKER_ENV_PATH,
            worker.pw_uid,
            worker.pw_gid,
            0o600,
            MAX_ENV_BYTES,
        )
    except (KeyError, OSError, InvalidRequest) as error:
        raise ApplyFailure("policy-apply-failed") from error
    values = parse_environment(raw)

    def port(key, default):
        text = values.get(key, default)
        if (
            not isinstance(text, str)
            or not 1 <= len(text) <= 5
            or re.fullmatch(r"[0-9]+", text) is None
        ):
            raise ApplyFailure("policy-apply-failed")
        try:
            value = int(text)
        except ValueError as error:
            raise ApplyFailure("policy-apply-failed") from error
        if not is_integer(value, 1024, 65535):
            raise ApplyFailure("policy-apply-failed")
        return value

    first = port("RTSP_UDP_PORT_FIRST", "24000")
    last = port("RTSP_UDP_PORT_LAST", "24001")
    if first > last or last - first + 1 > MAX_UDP_PORTS:
        raise ApplyFailure("policy-apply-failed")
    if worker.pw_uid == stream.pw_uid:
        raise ApplyFailure("policy-apply-failed")
    return worker.pw_uid, stream.pw_uid, first, last


def policy_for(settings, rtsp_enabled):
    worker_uid, stream_uid, udp_first, udp_last = policy_runtime_values()
    allowed = (
        settings["allowedCameraCidrs"]
        if settings["enabled"] and rtsp_enabled
        else []
    )
    value = {
        "version": 2,
        "settingsGeneration": settings["generation"],
        "rtspEnabled": rtsp_enabled,
        "workerUid": worker_uid,
        "streamUid": stream_uid,
        "allowedCidrs": allowed,
        "udpPortFirst": udp_first,
        "udpPortLast": udp_last,
    }
    return parse_policy(canonical_json(value))


def write_policy_atomic(policy):
    payload = canonical_json(policy)
    parse_policy(payload)
    descriptor = directory_fd(
        POLICY_DIRECTORY, ROOT_UID, ROOT_GID, 0o755
    )
    try:
        write_atomic(
            descriptor,
            os.path.basename(POLICY_PATH),
            payload,
            ROOT_UID,
            ROOT_GID,
            0o600,
        )
    finally:
        os.close(descriptor)


def load_policy_inspector():
    loader = importlib.machinery.SourceFileLoader("live_stream_policy_inspector", POLICY_INSPECTOR_PATH)
    module = importlib.util.module_from_spec(importlib.util.spec_from_loader(loader.name, loader))
    loader.exec_module(module)
    return module


def provision_summary(refresh=False):
    """Publish the physical projection before any private policy activation."""
    inspector = load_policy_inspector()
    descriptor = directory_fd(POLICY_DIRECTORY, ROOT_UID, ROOT_GID, 0o755)
    try:
        try:
            existing = open_entry(descriptor, os.path.basename(SUMMARY_PATH), ROOT_UID, ROOT_GID, 0o644, inspector.MAX_OUTPUT_BYTES)
            if not refresh:
                inspector.parse_policy_document(inspector.strict_json_loads(existing.decode("utf-8")))
                return
        except FileNotFoundError:
            pass
        worker, stream, first, last = policy_runtime_values()
        networks = inspector.current_networks()
        summary = inspector.policy_payload(inspector.POLICY_VERSION, worker, stream, networks, first, last)
        summary["digest"] = inspector.policy_digest(inspector.POLICY_VERSION, worker, stream, networks, first, last)
        inspector.parse_policy_document(summary)
        payload = canonical_json(summary)
        if len(payload) > inspector.MAX_OUTPUT_BYTES:
            raise InvalidRequest("summary too large")
        write_atomic(descriptor, os.path.basename(SUMMARY_PATH), payload, ROOT_UID, ROOT_GID, 0o644)
    except (OSError, ValueError, RuntimeError, inspector.PolicyDocumentInvalid, inspector.Unavailable) as error:
        raise ApplyFailure("policy-apply-failed") from error
    finally:
        os.close(descriptor)


def read_installed_policy(allow_legacy=False):
    descriptor = directory_fd(
        POLICY_DIRECTORY, ROOT_UID, ROOT_GID, 0o755
    )
    try:
        data = open_entry(
            descriptor,
            os.path.basename(POLICY_PATH),
            ROOT_UID,
            ROOT_GID,
            0o600,
            MAX_BYTES,
        )
        try:
            return parse_policy(data)
        except InvalidRequest:
            if not allow_legacy:
                raise
            previous = strict_json(data)
            inspector = load_policy_inspector()
            try:
                _version, worker, stream, networks, first, last, digest = inspector.parse_policy_document(previous)
            except inspector.PolicyDocumentInvalid as error:
                raise InvalidRequest("legacy policy") from error
            canonical = inspector.policy_payload(inspector.POLICY_VERSION, worker, stream, networks, first, last)
            canonical["digest"] = digest
            if data != canonical_json(canonical):
                raise InvalidRequest("noncanonical legacy policy")
            return None
    finally:
        os.close(descriptor)


def run_systemctl(arguments):
    try:
        completed = subprocess.run(
            [SYSTEMCTL, *arguments],
            cwd="/",
            env=SAFE_ENV,
            shell=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=COMMAND_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise ApplyFailure("service-unhealthy") from error
    if completed.returncode != 0:
        raise ApplyFailure("service-unhealthy")


def activate_policy(policy):
    run_systemctl(("restart", STREAM_NET_UNIT))
    run_systemctl(("is-active", "--quiet", STREAM_NET_UNIT))
    try:
        installed = read_installed_policy()
    except (OSError, InvalidRequest, RuntimeError) as error:
        raise ApplyFailure("service-unhealthy") from error
    if installed != policy:
        raise ApplyFailure("service-unhealthy")


def install_policy(policy, refresh_summary=False):
    try:
        try:
            installed = read_installed_policy(allow_legacy=True)
        except FileNotFoundError:
            installed = None
        provision_summary(refresh=refresh_summary)
        if installed != policy:
            write_policy_atomic(policy)
    except ApplyFailure:
        raise
    except (OSError, InvalidRequest, RuntimeError) as error:
        raise ApplyFailure("policy-apply-failed") from error
    activate_policy(policy)


def rtsp_assets_state():
    def state(path, mode):
        try:
            value = os.stat(path, follow_symlinks=False)
        except FileNotFoundError:
            return RTSP_ASSETS_ABSENT
        except OSError:
            return RTSP_ASSETS_UNSAFE
        if (
            stat.S_ISREG(value.st_mode)
            and value.st_nlink == 1
            and value.st_uid == ROOT_UID
            and value.st_gid == ROOT_GID
            and stat.S_IMODE(value.st_mode) == mode
        ):
            return RTSP_ASSETS_VALID
        return RTSP_ASSETS_UNSAFE

    states = (
        state(NET_HELPER_PATH, 0o755),
        state(STREAM_NET_UNIT_PATH, 0o644),
    )
    if all(value == RTSP_ASSETS_ABSENT for value in states):
        return RTSP_ASSETS_ABSENT
    if all(value == RTSP_ASSETS_VALID for value in states):
        return RTSP_ASSETS_VALID
    return RTSP_ASSETS_UNSAFE


def write_terminal_result(value, worker_gid):
    payload = canonical_json(value)
    parse_result(payload, value["requestId"], value["kind"])
    descriptor = directory_fd(
        RESULT_DIRECTORY, ROOT_UID, worker_gid, 0o750
    )
    try:
        write_atomic(
            descriptor,
            value["requestId"] + ".json",
            payload,
            ROOT_UID,
            worker_gid,
            0o640,
        )
    finally:
        os.close(descriptor)


def open_terminal_result(result_fd, request_id, kind, worker_gid):
    data = open_entry(
        result_fd,
        request_id + ".json",
        ROOT_UID,
        worker_gid,
        0o640,
        MAX_BYTES,
    )
    return parse_result(data, request_id, kind)


def process_acknowledgements(ack_fd, result_fd, worker_uid, worker_gid):
    for name in matching_entries(ack_fd, ACK_ENTRY):
        request_id = ACK_ENTRY.fullmatch(name).group(1)
        try:
            data = open_entry(
                ack_fd,
                name,
                worker_uid,
                worker_gid,
                0o600,
                0,
                allow_empty=True,
            )
            if data != b"":
                raise InvalidRequest("ack payload")
            terminal_data = open_entry(
                result_fd,
                request_id + ".json",
                ROOT_UID,
                worker_gid,
                0o640,
                MAX_BYTES,
            )
            parse_result(terminal_data, request_id)
        except (FileNotFoundError, OSError, InvalidRequest):
            continue
        # Ack first: a crash leaves a terminal result the worker can
        # acknowledge again, never an uncorrelated ack that authorizes deletion.
        remove_entry(ack_fd, name)
        remove_entry(result_fd, request_id + ".json")


def candidate_document(request):
    expected = request["expectedGeneration"]
    if expected == MAX_SAFE_INTEGER:
        raise ApplyFailure("settings-state-unsafe")
    return {
        "version": 1,
        "generation": expected + 1,
        "enabled": request["settings"]["enabled"],
        "allowedCameraCidrs": request["settings"]["allowedCameraCidrs"],
    }


def terminal_result_authoritative(value, request, worker_gid, replay):
    if value["outcome"] == "failed":
        # A failed result cannot carry the candidate tuple. Only a canonical
        # root-sealed claim proves which request this terminal belongs to.
        return replay
    if request["kind"] == "settings-mutation":
        try:
            candidate = candidate_document(request)
            current = read_settings(worker_gid)
        except (ApplyFailure, InvalidRequest):
            return False
        return (
            value["resultingGeneration"] == request["expectedGeneration"] + 1
            and value["resultingRtspEnabled"] == request["rtspEnabled"]
            and current == candidate
        )
    return (
        value["resultingGeneration"] == request["expectedGeneration"]
        and value["resultingRtspEnabled"] == request["rtspEnabled"]
    )


def prepare_request(request, worker_gid, replay):
    current = read_settings(worker_gid)
    expected = request["expectedGeneration"]
    if request["kind"] == "rtsp-state-reconcile":
        if current["generation"] != expected:
            raise ApplyFailure("stale-generation")
        return current, None, False

    candidate = candidate_document(request)
    if current["generation"] == expected:
        return current, candidate, False
    if replay and current == candidate:
        return current, candidate, True
    raise ApplyFailure("stale-generation")


def apply_settings_mutation(request, worker_gid, candidate, committed_replay):
    if not committed_replay:
        current = read_settings(worker_gid)
        if current["generation"] != request["expectedGeneration"]:
            raise ApplyFailure("stale-generation")
    assets = rtsp_assets_state()
    if assets == RTSP_ASSETS_UNSAFE:
        raise ApplyFailure("policy-apply-failed")
    if committed_replay:
        if assets == RTSP_ASSETS_VALID:
            install_policy(policy_for(candidate, request["rtspEnabled"]))
        # The settings commit point has passed. Marker cleanup is independent
        # and can be retried without changing the terminal success.
        try:
            remove_attention_marker()
        except (OSError, InvalidRequest, ApplyFailure, RuntimeError):
            pass
        return candidate["generation"], request["rtspEnabled"]

    marker_present = read_attention_marker(worker_gid)
    if assets == RTSP_ASSETS_VALID:
        install_policy(policy_for(candidate, request["rtspEnabled"]))
    write_settings_atomic(candidate, worker_gid)
    if marker_present:
        try:
            remove_attention_marker()
        except (OSError, InvalidRequest, ApplyFailure, RuntimeError):
            # Settings already committed. Retaining the validated marker is a
            # recoverable cleanup issue, not a rollback of authoritative state.
            pass
    return candidate["generation"], request["rtspEnabled"]


def apply_rtsp_reconcile(request, current):
    if current["generation"] != request["expectedGeneration"]:
        raise ApplyFailure("stale-generation")
    assets = rtsp_assets_state()
    if assets == RTSP_ASSETS_ABSENT:
        raise ApplyFailure("rtsp-assets-absent")
    if assets != RTSP_ASSETS_VALID:
        raise ApplyFailure("policy-apply-failed")
    install_policy(policy_for(current, request["rtspEnabled"]))
    return current["generation"], request["rtspEnabled"]


def process_one():
    worker_uid, worker_gid = worker_ids()
    validate_fixed_parents()
    validate_layout(worker_uid, worker_gid)
    request_fd = directory_fd(
        REQUEST_DIRECTORY, ROOT_UID, worker_gid, 0o770
    )
    claim_fd = directory_fd(CLAIM_DIRECTORY, ROOT_UID, ROOT_GID, 0o700)
    result_fd = directory_fd(RESULT_DIRECTORY, ROOT_UID, worker_gid, 0o750)
    ack_fd = directory_fd(ACK_DIRECTORY, ROOT_UID, worker_gid, 0o770)
    try:
        bundle_failure = False
        try:
            validate_root_bundle()
        except RuntimeError:
            bundle_failure = True
        if not bundle_failure:
            process_acknowledgements(
                ack_fd, result_fd, worker_uid, worker_gid
            )
        name = claim_next(request_fd, claim_fd)
        if name is None:
            if bundle_failure:
                raise RuntimeError("helper-version-mismatch")
            return False
        try:
            claim_data, replay = open_claim(
                claim_fd, name, worker_uid, worker_gid
            )
        except InvalidRequest:
            quarantine_claim(claim_fd, name)
            return True
        try:
            request = parse_request(claim_data, name)
        except InvalidRequest as error:
            if error.identity is not None:
                terminal = result_payload(
                    error.identity, "failed", "request-invalid"
                )
                write_terminal_result(terminal, worker_gid)
            remove_entry(claim_fd, name)
            return True

        if replay and claim_data != canonical_json(request):
            # Root ownership is replay authority only for the exact canonical
            # evidence written after the initial generation CAS.
            raise RuntimeError("unsafe replay claim")

        try:
            existing = open_terminal_result(
                result_fd,
                request["requestId"],
                request["kind"],
                worker_gid,
            )
            if not terminal_result_authoritative(
                existing, request, worker_gid, replay
            ):
                raise RuntimeError("ambiguous terminal result")
            remove_entry(claim_fd, name)
            return True
        except FileNotFoundError:
            pass
        except InvalidRequest as error:
            raise RuntimeError("unsafe terminal result") from error

        try:
            current, candidate, committed_replay = prepare_request(
                request, worker_gid, replay
            )
            if not replay:
                seal_claim(claim_fd, name, request)
            if bundle_failure:
                raise ApplyFailure("helper-version-mismatch")
            if request["kind"] == "settings-mutation":
                generation, rtsp_enabled = apply_settings_mutation(
                    request, worker_gid, candidate, committed_replay
                )
            elif request["kind"] == "rtsp-state-reconcile":
                generation, rtsp_enabled = apply_rtsp_reconcile(
                    request, current
                )
            else:
                raise ApplyFailure("request-invalid")
            terminal = result_payload(
                request,
                "succeeded",
                generation=generation,
                rtsp_enabled=rtsp_enabled,
            )
        except ApplyFailure as error:
            terminal = result_payload(request, "failed", error.code)
        write_terminal_result(terminal, worker_gid)
        remove_entry(claim_fd, name)
        return True
    finally:
        os.close(ack_fd)
        os.close(result_fd)
        os.close(claim_fd)
        os.close(request_fd)


def bootstrap_rtsp():
    try:
        lock = lock_applier()
    except BlockingIOError:
        return False
    try:
        worker_uid, worker_gid = worker_ids()
        validate_fixed_parents()
        validate_layout(worker_uid, worker_gid)
        validate_root_bundle()
        assets = rtsp_assets_state()
        if assets == RTSP_ASSETS_ABSENT:
            raise ApplyFailure("rtsp-assets-absent")
        if assets != RTSP_ASSETS_VALID:
            raise ApplyFailure("policy-apply-failed")
        current = read_settings(worker_gid)
        install_policy(policy_for(current, False), refresh_summary=True)
        return True
    finally:
        os.close(lock)


def reset_live_view_settings():
    """Commit deny-all and generation zero as one shared-lock operation."""
    try:
        lock = lock_applier()
    except BlockingIOError:
        return False
    try:
        worker_uid, worker_gid = worker_ids()
        validate_fixed_parents()
        validate_layout(worker_uid, worker_gid)
        validate_root_bundle()
        marker_identity = reset_attention_marker_identity(worker_gid)
        assets = rtsp_assets_state()
        if assets == RTSP_ASSETS_UNSAFE:
            raise ApplyFailure("policy-apply-failed")
        safe = {
            "version": 1,
            "generation": 0,
            "enabled": False,
            "allowedCameraCidrs": [],
        }
        if assets == RTSP_ASSETS_VALID:
            install_policy(policy_for(safe, False))
        write_settings_atomic(safe, worker_gid)
        remove_reset_attention_marker(marker_identity, worker_gid)
        return True
    finally:
        os.close(lock)


def run_spool_once():
    try:
        lock = lock_applier()
    except BlockingIOError:
        return True
    try:
        process_one()
        return True
    finally:
        os.close(lock)


def main(argv=None):
    arguments = sys.argv[1:] if argv is None else argv
    if os.geteuid() != 0:
        return 1
    if arguments == ["--bootstrap-rtsp"]:
        try:
            return 0 if bootstrap_rtsp() else 3
        except (OSError, RuntimeError, InvalidRequest, ApplyFailure):
            return 3
    if arguments == ["--reset-live-view-settings"]:
        try:
            return 0 if reset_live_view_settings() else 3
        except (OSError, RuntimeError, InvalidRequest, ApplyFailure):
            return 3
    if arguments:
        return 2
    try:
        return 0 if run_spool_once() else 3
    except (OSError, RuntimeError, InvalidRequest, ApplyFailure):
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
