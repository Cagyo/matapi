#!/bin/bash
set -euo pipefail
FEATURE="${1:-}"
APT_LOCK_TIMEOUT_SECONDS=300
if [ "${HOME_WORKER_PRIVILEGED:-0}" = "1" ]; then
  # The root-owned helper supplies only a fixed feature argument and a
  # sanitized environment.  Do not inherit install paths or account selectors.
  USER="homeworker"
  # Routines may read only the fixed worker configuration, never executable
  # templates from the worker-writable application tree.
  SCRIPT_DIR="/usr/lib/home-worker"
  INSTALL_DIR="/opt/home-worker"
  ROOT_BUNDLE_DIR="/usr/lib/home-worker"
  # Keep the fixed routines byte-for-byte command compatible: several of them
  # intentionally switch to the fixed homeworker account. When this process is
  # already root, sudo's setuid transition is unavailable under the install
  # unit's NoNewPrivileges=yes and unnecessary anyway; runuser drops privilege
  # via setuid()/setgid() rather than exec'ing a setuid binary, so it still
  # works. A non-root caller (e.g. a manual wizard run) still needs real sudo.
  if [ "$EUID" -eq 0 ]; then
    export HOME=/root
    sudo() { "$@"; }
    run_as_worker() { runuser -u "$USER" -- "$@"; }
  else
    sudo() { /usr/bin/sudo "$@"; }
    run_as_worker() { /usr/bin/sudo -u "$USER" "$@"; }
  fi
else
  USER="${HOME_WORKER_USER:-homeworker}"
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  INSTALL_DIR="${HOME_WORKER_INSTALL_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
  ROOT_BUNDLE_DIR="$INSTALL_DIR"
  run_as_worker() { sudo -H -u "$USER" "$@"; }
fi

# The RTSP durable tuple, spelled once. Staging, the commit, and the stale-file
# reaper all address exactly these three paths, and the private worker
# environment has no second location.
RTSP_POLICY_DIR="/etc/home-worker"
RTSP_POLICY_FILE="$RTSP_POLICY_DIR/live-stream-policy.json"
RTSP_SUMMARY_FILE="$RTSP_POLICY_DIR/live-stream-policy.summary.json"
RTSP_ENV_FILE="$INSTALL_DIR/.env"

apt_get() {
  sudo apt-get -o "DPkg::Lock::Timeout=${APT_LOCK_TIMEOUT_SECONDS}" "$@"
}

install_root_asset_if_distinct() {
  local source="$1" target="$2" mode="$3"
  # Privileged routines run from the already-validated root bundle. Reinstalling
  # a bundle executable over itself fails on some systems and is unnecessary.
  [ "$source" = "$target" ] && return 0
  sudo install -m "$mode" -o root -g root "$source" "$target"
}

discard_staged_rtsp_policy() {
  # Staged files are the only mutation the pre-package phase performs, so a
  # failed staging attempt leaves the previously installed tuple untouched.
  local target
  for target in "$@"; do
    sudo rm -f "$target.staged"
  done
}

rtsp_runtime_install_skipped() {
  [ "${HOME_WORKER_RTSP_SKIP_RUNTIME_INSTALL:-0}" = "1" ] && [ "${VITEST:-}" = "true" ]
}

require_eligible_local_network() {
  # Runs before the Cloudflare keyring, the apt source, `apt-get update`, and
  # every package: a host with no eligible local network must fail closed
  # before any repository or package mutation, never after one.
  #
  # This gate answers one narrow question -- is anything eligible at all -- and
  # deliberately does not re-validate entries. The staging program re-runs
  # discovery and validates every field authoritatively before it writes a
  # single durable byte, so this must never become a second policy parser.
  if ! sudo python3 - "$SCRIPT_DIR/live-stream-policy-inspector" <<'PY'
import importlib.machinery, importlib.util, subprocess, sys
inspector_path = sys.argv[1]
MAX_BYTES = 64 * 1024
loader = importlib.machinery.SourceFileLoader("live_stream_policy_inspector", inspector_path)
inspector = importlib.util.module_from_spec(importlib.util.spec_from_loader(loader.name, loader))
loader.exec_module(inspector)
try:
    completed = subprocess.run(
        [inspector_path, "discover"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, timeout=30, check=False)
except (OSError, subprocess.SubprocessError):
    raise SystemExit("local network discovery failed")
if completed.returncode != 0 or len(completed.stdout) > MAX_BYTES:
    raise SystemExit("local network discovery failed")
try:
    payload = inspector.strict_json_loads(completed.stdout.decode("utf-8"))
except (UnicodeDecodeError, ValueError):
    raise SystemExit("local network discovery failed")
if not isinstance(payload, dict) or payload.get("version") != inspector.POLICY_VERSION:
    raise SystemExit("local network discovery failed")
if not isinstance(payload.get("networks"), list):
    raise SystemExit("local network discovery failed")
if not payload["networks"]:
    raise SystemExit("no eligible local network")
PY
  then
    echo "ERROR: no eligible local network for the RTSP runtime" >&2
    return 1
  fi
}

reap_stale_rtsp_staging() {
  # A crash during staging leaves staged files behind, one of which holds a
  # credential key that was never committed. Reap them at branch entry so no
  # secret-shaped artifact outlives the install that produced it.
  discard_staged_rtsp_policy "$RTSP_POLICY_FILE" "$RTSP_SUMMARY_FILE" "$RTSP_ENV_FILE"
}

install_rtsp_runtime() {
  local stream_user="homeworker-stream"
  local stream_group="homeworker-stream"
  local env_file="$RTSP_ENV_FILE"
  local policy_dir="$RTSP_POLICY_DIR"
  local policy_file="$RTSP_POLICY_FILE"
  local summary_file="$RTSP_SUMMARY_FILE"
  local inspector="$SCRIPT_DIR/live-stream-policy-inspector"
  local root_uid=0 root_gid=0

  if ! [[ "$USER" =~ ^[a-z_][a-z0-9_-]*$ ]]; then
    echo "ERROR: unsafe worker account name" >&2
    return 1
  fi

  # The staged policy binds both runtime UIDs, so the accounts exist before
  # staging.  Account creation installs no package and is reconciliation safe.
  if ! getent group "$stream_group" >/dev/null; then
    sudo groupadd --system "$stream_group"
  fi
  if ! id "$stream_user" >/dev/null 2>&1; then
    sudo useradd --system --no-create-home --home-dir /nonexistent \
      --shell /usr/sbin/nologin --gid "$stream_group" "$stream_user"
  fi
  sudo usermod --home /nonexistent --shell /usr/sbin/nologin --gid "$stream_group" "$stream_user"
  sudo usermod -L "$stream_user"
  sudo usermod -aG "$stream_group" "$USER"

  if ! sudo test -f "$env_file"; then
    echo "ERROR: $env_file is required before RTSP runtime installation" >&2
    return 1
  fi

  sudo install -d -m 0755 -o root -g root "$policy_dir" /etc/home-worker/ca /usr/lib/home-worker /etc/polkit-1/rules.d /etc/tmpfiles.d

  # Stage the whole durable tuple before any RTSP package mutation: discovery,
  # the private policy, the public summary, and the private environment are all
  # written to same-directory staged files and flushed, so a failure here can
  # only leave staged files behind.  Credential keys are generated only when
  # absent/blank; existing non-empty keys are never printed or replaced and
  # malformed non-empty values fail closed.
  local env_identity
  if ! env_identity="$(sudo python3 - "$inspector" "$env_file" "$policy_file" "$summary_file" "$root_uid" "$root_gid" "$(id -u "$USER")" "$(id -u "$stream_user")" <<'PY'
import importlib.machinery, importlib.util, json, os, re, secrets, stat, subprocess, sys

(inspector_path, env_path, policy_path, summary_path,
 root_uid_text, root_gid_text, worker_uid_text, stream_uid_text) = sys.argv[1:]
DIGITS = re.compile(r"\d+")
HEX_KEY = re.compile(r"[0-9a-fA-F]{64}")
O_CLOEXEC = getattr(os, "O_CLOEXEC", 0)
O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
MAX_BYTES = 64 * 1024
DISCOVERY_TIMEOUT_SECONDS = 30
if not all(DIGITS.fullmatch(text) for text in (root_uid_text, root_gid_text, worker_uid_text, stream_uid_text)):
    raise SystemExit("unsafe runtime identity")
root_uid, root_gid = int(root_uid_text), int(root_gid_text)
worker_uid, stream_uid = int(worker_uid_text), int(stream_uid_text)
if worker_uid == stream_uid:
    raise SystemExit("unsafe runtime uid policy")

# Root code loading root code from its fixed bundle path: the digest and every
# canonical rule stay defined exactly once, in the inspector both verifiers use.
loader = importlib.machinery.SourceFileLoader("live_stream_policy_inspector", inspector_path)
inspector = importlib.util.module_from_spec(importlib.util.spec_from_loader(loader.name, loader))
loader.exec_module(inspector)


def discovered_networks():
    try:
        completed = subprocess.run(
            [inspector_path, "discover"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, timeout=DISCOVERY_TIMEOUT_SECONDS, check=False)
    except (OSError, subprocess.SubprocessError):
        raise SystemExit("local network discovery failed")
    if completed.returncode != 0 or len(completed.stdout) > MAX_BYTES:
        raise SystemExit("local network discovery failed")
    try:
        payload = inspector.strict_json_loads(completed.stdout.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise SystemExit("local network discovery failed")
    if not isinstance(payload, dict) or set(payload) != {"version", "networks"}:
        raise SystemExit("local network discovery failed")
    if payload["version"] != inspector.POLICY_VERSION or not isinstance(payload["networks"], list):
        raise SystemExit("local network discovery failed")
    networks = []
    for entry in payload["networks"]:
        if not isinstance(entry, dict) or set(entry) != {"family", "cidr", "interface"}:
            raise SystemExit("local network discovery failed")
        network = inspector.parse_network(entry["cidr"])
        if network is None or entry["family"] != network.version or not inspector.valid_interface(entry["interface"]):
            raise SystemExit("local network discovery failed")
        networks.append(inspector.EligibleNetwork(
            family=network.version, cidr=str(network), interface=entry["interface"]))
    order = [inspector.network_key(entry) for entry in networks]
    if order != sorted(order) or len(set(order)) != len(order):
        raise SystemExit("local network discovery failed")
    # `discover` reports "nothing eligible" as a successful empty projection.
    # Refusing to stage it here is what keeps an unbound policy off the device.
    if not networks:
        raise SystemExit("no eligible local network")
    return networks


networks = discovered_networks()
try:
    env_fd = os.open(env_path, os.O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
except OSError:
    raise SystemExit("unsafe env file")
env_stat = os.fstat(env_fd)
if (not stat.S_ISREG(env_stat.st_mode) or env_stat.st_nlink != 1
        or env_stat.st_uid != worker_uid or stat.S_IMODE(env_stat.st_mode) != 0o600):
    os.close(env_fd)
    raise SystemExit("unsafe env file")
try:
    with os.fdopen(env_fd, "rb") as stream:
        env_raw = stream.read(MAX_BYTES + 1)
except OSError:
    raise SystemExit("unsafe env file")
if len(env_raw) > MAX_BYTES:
    raise SystemExit("unsafe env file")
try:
    lines = env_raw.decode("utf-8").splitlines()
except UnicodeDecodeError:
    # Never re-raise: the decoder embeds the offending bytes in its message.
    raise SystemExit("unsafe env file")
positions = {}
for index, line in enumerate(lines):
    if not line or line.startswith("#") or "=" not in line:
        continue
    key = line.split("=", 1)[0]
    if key in positions:
        raise SystemExit("duplicate policy setting")
    positions[key] = index


def setting(key, default=""):
    # A present-but-blank setting means "unset": the installer supplies its own
    # default and regenerates a blank credential key, rather than hard-blocking
    # an install until somebody hand-edits the private environment.
    if key not in positions:
        return default
    value = lines[positions[key]].split("=", 1)[1].strip().strip('"').strip("'")
    return value if value else default


def assign(key, value):
    if key in positions:
        lines[positions[key]] = key + "=" + value
    else:
        positions[key] = len(lines)
        lines.append(key + "=" + value)


def udp_port(key, default):
    text = setting(key, default)
    if not DIGITS.fullmatch(text):
        raise SystemExit("unsafe RTSP UDP range")
    return int(text)


udp_first = udp_port("RTSP_UDP_PORT_FIRST", "24000")
udp_last = udp_port("RTSP_UDP_PORT_LAST", "24001")
if not inspector.valid_udp_port(udp_first) or not inspector.valid_udp_port(udp_last):
    # Policy version 2 refuses privileged ports outright. Name the bound so an
    # operator who pinned a low port knows exactly what to change.
    raise SystemExit(
        "RTSP_UDP_PORT_FIRST/RTSP_UDP_PORT_LAST must be within 1024..65535")
if udp_first > udp_last or udp_last - udp_first + 1 > 64:
    raise SystemExit("unsafe RTSP UDP range")
credential_key = setting("RTSP_CREDENTIALS_KEY")
if credential_key and not HEX_KEY.fullmatch(credential_key):
    raise SystemExit("malformed RTSP credential key")
if not credential_key:
    assign("RTSP_CREDENTIALS_KEY", secrets.token_hex(32))

digest = inspector.policy_digest(
    inspector.POLICY_VERSION, worker_uid, stream_uid, networks, udp_first, udp_last)
cidrs = []
for entry in networks:
    if entry.cidr not in cidrs:
        cidrs.append(entry.cidr)
assign("RTSP_ALLOWED_CIDRS", ",".join(cidrs))
assign("RTSP_POLICY_DIGEST", digest)
document = {
    "version": inspector.POLICY_VERSION,
    "workerUid": worker_uid,
    "streamUid": stream_uid,
    "networks": inspector.projection(networks),
    "udpPortFirst": udp_first,
    "udpPortLast": udp_last,
    "digest": digest,
}
policy_body = (json.dumps(document, separators=(",", ":"), sort_keys=True) + "\n").encode("utf-8")
env_body = ("\n".join(lines) + "\n").encode("utf-8")


def fsync_directory(path):
    fd = os.open(os.path.dirname(path) or ".", os.O_RDONLY | O_CLOEXEC)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def stage(path, body, uid, gid, mode):
    # Deterministic name, but created exclusively: `.env.staged` sits in a
    # worker-writable directory, so root must never adopt a file it did not
    # create.  A racing creation between the unlink and the open fails closed.
    staged = path + ".staged"
    try:
        try:
            os.unlink(staged)
        except FileNotFoundError:
            pass
        fd = os.open(staged, os.O_WRONLY | os.O_CREAT | os.O_EXCL | O_CLOEXEC | O_NOFOLLOW, mode)
        try:
            os.fchmod(fd, mode)
            os.fchown(fd, uid, gid)
            os.write(fd, body)
            os.fsync(fd)
        finally:
            os.close(fd)
        fsync_directory(staged)
        # Re-read what actually landed: this catches a short write and refuses a
        # staged path that turned into a link between the two opens.
        check = os.open(staged, os.O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
        try:
            if os.read(check, MAX_BYTES + 1) != body:
                raise SystemExit("staged policy did not persist")
        finally:
            os.close(check)
    except OSError:
        # A worker that plants a directory (or anything else) under the staged
        # name gets the short refusal, never a traceback on the root stderr.
        # NOTE: this program is fed through $( ... ), where a stray apostrophe
        # would break the command substitution -- keep this heredoc free of them.
        raise SystemExit("staged policy could not be written")


stage(policy_path, policy_body, root_uid, root_gid, 0o600)
stage(summary_path, policy_body, root_uid, root_gid, 0o644)
stage(env_path, env_body, worker_uid, env_stat.st_gid, 0o600)
# The only output: the identity of the environment file these settings were
# read from, so the commit refuses to overwrite a file replaced since staging.
sys.stdout.write("{}:{}\n".format(env_stat.st_dev, env_stat.st_ino))
PY
  )"; then
    discard_staged_rtsp_policy "$policy_file" "$summary_file" "$env_file"
    return 1
  fi

  # Debian 13 removed the legacy policykit-1 package name. Install the
  # concrete daemon and client packages used by the systemd authorization flow.
  if ! apt_get install -y ffmpeg nftables polkitd pkexec; then
    discard_staged_rtsp_policy "$policy_file" "$summary_file" "$env_file"
    return 1
  fi

  # Revalidate the staged tuple and commit it in the fixed order: private
  # policy, public summary, environment.  The three renames cannot be globally
  # atomic; a crash between them leaves a mixed tuple that both privileged and
  # application readiness reject until an idempotent reinstall reconciles it.
  if ! sudo python3 - "$inspector" "$policy_file" "$summary_file" "$env_file" "$root_uid" "$root_gid" "$(id -u "$USER")" "$env_identity" <<'PY'
import importlib.machinery, importlib.util, os, re, stat, sys

(inspector_path, policy_path, summary_path, env_path,
 root_uid_text, root_gid_text, worker_uid_text, env_identity_text) = sys.argv[1:]
DIGITS = re.compile(r"\d+")
IDENTITY = re.compile(r"(\d+):(\d+)")
HEX_KEY = re.compile(r"[0-9a-fA-F]{64}")
O_CLOEXEC = getattr(os, "O_CLOEXEC", 0)
O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
MAX_BYTES = 64 * 1024
if not all(DIGITS.fullmatch(text) for text in (root_uid_text, root_gid_text, worker_uid_text)):
    raise SystemExit("unsafe runtime identity")
root_uid, root_gid, worker_uid = int(root_uid_text), int(root_gid_text), int(worker_uid_text)
identity = IDENTITY.fullmatch(env_identity_text.strip())
if identity is None:
    raise SystemExit("unsafe runtime identity")
env_device, env_inode = int(identity.group(1)), int(identity.group(2))

loader = importlib.machinery.SourceFileLoader("live_stream_policy_inspector", inspector_path)
inspector = importlib.util.module_from_spec(importlib.util.spec_from_loader(loader.name, loader))
loader.exec_module(inspector)


def read_private(path, uid, gid, mode):
    try:
        fd = os.open(path, os.O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
    except OSError:
        raise SystemExit("unsafe staged policy")
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != uid
                or (gid is not None and info.st_gid != gid)
                or stat.S_IMODE(info.st_mode) != mode):
            raise SystemExit("unsafe staged policy")
        body = os.read(fd, MAX_BYTES + 1)
    except OSError:
        raise SystemExit("unsafe staged policy")
    finally:
        os.close(fd)
    if len(body) > MAX_BYTES:
        raise SystemExit("unsafe staged policy")
    return body


policy_body = read_private(policy_path + ".staged", root_uid, root_gid, 0o600)
summary_body = read_private(summary_path + ".staged", root_uid, root_gid, 0o644)
env_body = read_private(env_path + ".staged", worker_uid, None, 0o600)
if policy_body != summary_body:
    raise SystemExit("staged policy disagreement")
try:
    document = inspector.strict_json_loads(policy_body.decode("utf-8"))
except (UnicodeDecodeError, ValueError):
    raise SystemExit("staged policy is not canonical")
keys = {"version", "workerUid", "streamUid", "networks", "udpPortFirst", "udpPortLast", "digest"}
if not isinstance(document, dict) or set(document) != keys or document["version"] != inspector.POLICY_VERSION:
    raise SystemExit("staged policy is not canonical")
if not inspector.valid_uid(document["workerUid"]) or not inspector.valid_uid(document["streamUid"]):
    raise SystemExit("staged policy is not canonical")
if document["workerUid"] != worker_uid or document["workerUid"] == document["streamUid"]:
    raise SystemExit("staged policy is not canonical")
if not inspector.valid_udp_port(document["udpPortFirst"]) or not inspector.valid_udp_port(document["udpPortLast"]):
    raise SystemExit("staged policy is not canonical")
if document["udpPortFirst"] > document["udpPortLast"]:
    raise SystemExit("staged policy is not canonical")
if not isinstance(document["networks"], list) or not document["networks"]:
    raise SystemExit("staged policy is not canonical")
networks = []
for entry in document["networks"]:
    if not isinstance(entry, dict) or set(entry) != {"family", "cidr", "interface"}:
        raise SystemExit("staged policy is not canonical")
    network = inspector.parse_network(entry["cidr"])
    if network is None or entry["family"] != network.version or not inspector.valid_interface(entry["interface"]):
        raise SystemExit("staged policy is not canonical")
    networks.append(inspector.EligibleNetwork(
        family=network.version, cidr=str(network), interface=entry["interface"]))
order = [inspector.network_key(entry) for entry in networks]
if order != sorted(order) or len(set(order)) != len(order):
    raise SystemExit("staged policy is not canonical")
digest = document["digest"]
if not isinstance(digest, str) or not inspector.DIGEST_RE.fullmatch(digest):
    raise SystemExit("staged policy is not canonical")
if digest != inspector.policy_digest(
        document["version"], document["workerUid"], document["streamUid"], networks,
        document["udpPortFirst"], document["udpPortLast"]):
    raise SystemExit("staged policy is not canonical")

try:
    env_text = env_body.decode("utf-8")
except UnicodeDecodeError:
    # Never re-raise: the decoder embeds the offending bytes in its message.
    raise SystemExit("staged environment is not readable")
values = {}
for raw in env_text.splitlines():
    if not raw or raw.startswith("#") or "=" not in raw:
        continue
    key, value = raw.split("=", 1)
    if key in values:
        raise SystemExit("duplicate policy setting")
    values[key] = value.strip().strip('"').strip("'")
cidrs = []
for entry in networks:
    if entry.cidr not in cidrs:
        cidrs.append(entry.cidr)
if values.get("RTSP_ALLOWED_CIDRS") != ",".join(cidrs) or values.get("RTSP_POLICY_DIGEST") != digest:
    raise SystemExit("staged environment disagreement")
if not HEX_KEY.fullmatch(values.get("RTSP_CREDENTIALS_KEY", "")):
    raise SystemExit("staged environment disagreement")
try:
    env_fd = os.open(env_path, os.O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
except OSError:
    raise SystemExit("unsafe env file")
try:
    info = os.fstat(env_fd)
    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != worker_uid
            or stat.S_IMODE(info.st_mode) != 0o600):
        raise SystemExit("unsafe env file")
    # The staged settings were derived from one specific file. If anything
    # replaced it since, committing would silently discard those edits.
    if info.st_dev != env_device or info.st_ino != env_inode:
        raise SystemExit("env file changed during update")
finally:
    os.close(env_fd)


def commit(path):
    # read_private already validated this staged file, and os.replace re-resolves
    # the name in a directory the worker can write. That window is benign: the
    # worker already owns the environment file this commit installs, protected
    # hardlinks block a cross-owner link, and everything renamed here was checked
    # for canonical shape, digest, CIDRs, and a hex credential key above.
    try:
        os.replace(path + ".staged", path)
        fd = os.open(os.path.dirname(path) or ".", os.O_RDONLY | O_CLOEXEC)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    except OSError:
        raise SystemExit("policy commit failed")


commit(policy_path)
commit(summary_path)
commit(env_path)
PY
  then
    # A commit failure before the first rename leaves the previous tuple whole;
    # one after a rename leaves a mixed tuple that readiness rejects. Either
    # way the stale staged files -- including a freshly generated credential
    # key -- are removed, and the reconciling reinstall stages the tuple again.
    discard_staged_rtsp_policy "$policy_file" "$summary_file" "$env_file"
    return 1
  fi

  install_root_asset_if_distinct "$SCRIPT_DIR/live-stream-net-helper" /usr/lib/home-worker/live-stream-net-helper 0755
  install_root_asset_if_distinct "$SCRIPT_DIR/live-stream-ffmpeg-runner" /usr/lib/home-worker/live-stream-ffmpeg-runner 0755
  sudo install -m 0644 -o root -g root "$ROOT_BUNDLE_DIR/systemd/homeworker-ffmpeg-stream@.service" /etc/systemd/system/homeworker-ffmpeg-stream@.service
  sudo install -m 0644 -o root -g root "$ROOT_BUNDLE_DIR/systemd/homeworker-stream-net.service" /etc/systemd/system/homeworker-stream-net.service
  local polkit_tmp
  polkit_tmp="$(mktemp)"
  sed "s/@HOME_WORKER_USER@/$USER/g" "$ROOT_BUNDLE_DIR/systemd/homeworker-stream-systemd.rules" > "$polkit_tmp"
  sudo install -m 0644 -o root -g root "$polkit_tmp" /etc/polkit-1/rules.d/49-homeworker-stream-systemd.rules
  rm -f "$polkit_tmp"
  local tmpfiles_tmp
  tmpfiles_tmp="$(mktemp)"
  cat > "$tmpfiles_tmp" <<EOF
d /run/home-worker 0750 root $stream_group - -
d /run/home-worker/live-stream-config 2730 root $stream_group - -
d /run/home-worker/live-stream-output 3770 root $stream_group - -
d /run/home-worker/live-source-probe 0700 $USER $USER - -
EOF
  sudo install -m 0644 -o root -g root "$tmpfiles_tmp" /etc/tmpfiles.d/homeworker-stream.conf
  rm -f "$tmpfiles_tmp"
  sudo systemd-tmpfiles --create /etc/tmpfiles.d/homeworker-stream.conf
  sudo systemctl daemon-reload
  sudo systemctl enable homeworker-stream-net.service
  sudo systemctl restart homeworker-stream-net.service
  sudo systemctl is-active --quiet homeworker-stream-net.service
}

case "$FEATURE" in
  motion)
    echo "Installing motion & ffmpeg dependencies..."
    apt_get install -y motion ffmpeg

    # Add user to motion and video groups for shared access
    sudo usermod -aG motion,video "$USER" 2>/dev/null || true

    # Create target media storage directories and make the whole path traversable
    # by the Motion daemon. Some Pi images keep /home/pi at 700 by default.
    sudo mkdir -p /home/pi/motion/videos /home/pi/motion/thumbnails
    sudo chmod 755 /home/pi
    sudo chown -R motion:motion /home/pi/motion 2>/dev/null || sudo chown -R "$USER:$USER" /home/pi/motion
    sudo chmod 755 /home/pi/motion
    sudo chmod -R 775 /home/pi/motion/videos
    sudo chmod -R 775 /home/pi/motion/thumbnails

    # Ensure log directory exists and persist across tmpfs reboots via systemd-tmpfiles
    sudo mkdir -p /var/log/motion
    sudo chown -R motion:motion /var/log/motion 2>/dev/null || true
    if [ -d /etc/tmpfiles.d ]; then
      cat <<EOF | sudo tee /etc/tmpfiles.d/motion.conf >/dev/null
d /var/log/motion 0755 motion motion - -
d /home/pi/motion 0755 motion motion - -
d /home/pi/motion/videos 0775 motion motion - -
d /home/pi/motion/thumbnails 0775 motion motion - -
EOF
      sudo systemd-tmpfiles --create /etc/tmpfiles.d/motion.conf 2>/dev/null || true
    fi

    # Configure /etc/motion/motion.conf
    if [ -f /etc/motion/motion.conf ]; then
      echo "Configuring /etc/motion/motion.conf..."

      set_motion_conf() {
        local key="$1"
        local val="$2"
        if sudo grep -qE "^[#[:space:]]*${key}[[:space:]]+" /etc/motion/motion.conf; then
          sudo sed -i -E "s|^[#[:space:]]*${key}[[:space:]]+.*|${key} ${val}|" /etc/motion/motion.conf
        else
          echo "${key} ${val}" | sudo tee -a /etc/motion/motion.conf >/dev/null
        fi
      }

      set_motion_conf videodevice /dev/video0
      set_motion_conf target_dir /home/pi/motion/videos
      set_motion_conf log_file /var/log/motion/motion.log
      set_motion_conf width 640
      set_motion_conf height 480
      set_motion_conf framerate 8
      # Motion 4.x renamed max_movie_time -> movie_max_time (4.x maps the old
      # name with a warning; 5.x drops it). Migrate any legacy line first.
      sudo sed -i -E 's/^[#[:space:]]*max_movie_time[[:space:]]+.*/movie_max_time 30/' /etc/motion/motion.conf
      set_motion_conf movie_max_time 30
      set_motion_conf movie_output on
      set_motion_conf movie_codec mpeg4
      set_motion_conf movie_filename "%Y/%m/%d/%H%M%S-%{eventid}"
      set_motion_conf picture_output first
      set_motion_conf picture_filename "../thumbnails/%Y/%m/%d/%H%M%S-%{eventid}"
      set_motion_conf stream_port 8081
      set_motion_conf stream_localhost on

      # Spec 20 internal webhooks. Motion runs these via `sh -c`, so the URLs
      # MUST be quoted — an unquoted `&` backgrounds curl and drops `file=%f`.
      # Delete any previous hook definitions, then append fresh quoted hooks.
      sudo sed -i -E '/^[#[:space:]]*on_(event_start|event_end|movie_start|movie_end|picture_save)[[:space:]]/d' /etc/motion/motion.conf
      cat <<'EOF' | sudo tee -a /etc/motion/motion.conf >/dev/null
on_event_start curl -s "http://localhost:4000/motion/event-start?camera=%t"
on_movie_end curl -s "http://localhost:4000/motion/movie-end?camera=%t&file=%f"
on_picture_save curl -s "http://localhost:4000/motion/snapshot?file=%f"
EOF
    fi

    # sudoers matches command paths as literal strings. On usr-merged Debian
    # (Bookworm) `sudo systemctl` resolves to /usr/bin/systemctl, on older
    # images to /bin/systemctl — list both so the worker's non-interactive
    # `sudo systemctl {start,stop,restart} motion` is never denied. The
    # generated rules live in the dedicated per-feature sudoers file.
    SUDOERS_TMP="$(mktemp)"
    cat > "$SUDOERS_TMP" <<EOF
$USER ALL=(ALL) NOPASSWD: /usr/bin/systemctl start motion, /usr/bin/systemctl stop motion, /usr/bin/systemctl restart motion
$USER ALL=(ALL) NOPASSWD: /bin/systemctl start motion, /bin/systemctl stop motion, /bin/systemctl restart motion
EOF
    if sudo visudo -c -f "$SUDOERS_TMP" >/dev/null; then
      sudo install -m 440 -o root -g root "$SUDOERS_TMP" /etc/sudoers.d/homeworker-motion
    else
      echo "ERROR: generated sudoers file failed validation; leaving existing rules untouched" >&2
      rm -f "$SUDOERS_TMP"
      exit 1
    fi
    rm -f "$SUDOERS_TMP"
    ;;
  zigbee)
    echo "Installing zigbee dependencies (mosquitto)..."
    apt_get install -y mosquitto mosquitto-clients
    ;;
  uart)
    echo "Configuring UART serial..."
    if command -v raspi-config &>/dev/null; then
      sudo raspi-config nonint do_serial_hw 0 || true
      sudo raspi-config nonint do_serial_cons 1 || true
    fi
    ;;
  rtsp)
    echo "Installing experimental cloudflared live-stream capability..."
    CLOUDFLARED_ARCH="${HOME_WORKER_DEBIAN_ARCH:-$(dpkg --print-architecture)}"
    case "$CLOUDFLARED_ARCH" in
      amd64|i386|armhf|arm64) ;;
      *)
        echo "ERROR: cloudflared is not supported on Debian architecture: $CLOUDFLARED_ARCH" >&2
        exit 1
        ;;
    esac

    # Discovery gates every mutation in this branch, not just the runtime
    # packages: without an eligible local network the install must fail before
    # the Cloudflare keyring, the apt source, and cloudflared itself.
    if ! rtsp_runtime_install_skipped; then
      reap_stale_rtsp_staging
      require_eligible_local_network
    fi

    if ! command -v cloudflared >/dev/null 2>&1; then
      CLOUDFLARE_KEYRING_DIR="${CLOUDFLARE_KEYRING_DIR:-/usr/share/keyrings}"
      CLOUDFLARE_SOURCE_LIST_DIR="${CLOUDFLARE_SOURCE_LIST_DIR:-/etc/apt/sources.list.d}"
      CLOUDFLARE_KEYRING="$CLOUDFLARE_KEYRING_DIR/cloudflare-main.gpg"
      CLOUDFLARE_SOURCE_LIST="$CLOUDFLARE_SOURCE_LIST_DIR/cloudflared.list"
      CLOUDFLARE_REPOSITORY="deb [signed-by=$CLOUDFLARE_KEYRING] https://pkg.cloudflare.com/cloudflared any main"

      sudo mkdir -p "$CLOUDFLARE_KEYRING_DIR" "$CLOUDFLARE_SOURCE_LIST_DIR"
      sudo chmod 0755 "$CLOUDFLARE_KEYRING_DIR" "$CLOUDFLARE_SOURCE_LIST_DIR"
      if ! sudo test -s "$CLOUDFLARE_KEYRING"; then
        CLOUDFLARE_KEY_TMP="$(mktemp)"
        if ! curl -fsSL -o "$CLOUDFLARE_KEY_TMP" https://pkg.cloudflare.com/cloudflare-main.gpg; then
          rm -f "$CLOUDFLARE_KEY_TMP"
          echo "ERROR: failed to download the Cloudflare apt signing key." >&2
          exit 1
        fi
        sudo install -m 0644 "$CLOUDFLARE_KEY_TMP" "$CLOUDFLARE_KEYRING"
        rm -f "$CLOUDFLARE_KEY_TMP"
      fi

      CLOUDFLARE_SOURCE_TMP="$(mktemp)"
      printf '%s\n' "$CLOUDFLARE_REPOSITORY" > "$CLOUDFLARE_SOURCE_TMP"
      if ! sudo cmp -s "$CLOUDFLARE_SOURCE_TMP" "$CLOUDFLARE_SOURCE_LIST"; then
        sudo install -m 0644 "$CLOUDFLARE_SOURCE_TMP" "$CLOUDFLARE_SOURCE_LIST"
      fi
      rm -f "$CLOUDFLARE_SOURCE_TMP"

      apt_get update
      apt_get install -y cloudflared
    fi

    CLOUDFLARED_BIN="$(command -v cloudflared)"
    # The installer owns the traversable parent and removes it with sudo. All
    # files below the private worker directory are created by the worker shell.
    DIAG_DIR="$(mktemp -d)"
    cleanup_cloudflared_diagnostics() {
      sudo rm -rf "$DIAG_DIR"
    }
    trap cleanup_cloudflared_diagnostics EXIT
    chmod 711 "$DIAG_DIR"
    DIAG_WORK_DIR="$DIAG_DIR/worker"
    DIAG_HOME="$DIAG_WORK_DIR/home"
    DIAG_CONFIG_DIR="$DIAG_WORK_DIR/config"
    DIAG_CONFIG="$DIAG_CONFIG_DIR/config.yml"
    sudo install -d -m 700 -o "$USER" -g "$USER" \
      "$DIAG_WORK_DIR" "$DIAG_HOME" "$DIAG_CONFIG_DIR"

    set +e
    run_as_worker env -i \
      PATH="/usr/local/bin:/usr/bin:/bin" \
      HOME="$DIAG_HOME" \
      XDG_CONFIG_HOME="$DIAG_CONFIG_DIR" \
      sh -c '
        set -eu
        work_dir="$1"
        config="$2"
        cloudflared_bin="$3"
        cd "$work_dir"
        : > "$config"
        "$cloudflared_bin" --config "$config" version >/dev/null 2>&1 || exit 1
        "$cloudflared_bin" --config "$config" tunnel diag >diagnostic.log 2>&1 || exit 2
      ' sh "$DIAG_WORK_DIR" "$DIAG_CONFIG" "$CLOUDFLARED_BIN"
    DIAG_STATUS=$?
    set -e
    if [ "$DIAG_STATUS" -eq 1 ]; then
      echo "ERROR: cloudflared was installed but its version check failed." >&2
      exit 1
    fi
    if [ "$DIAG_STATUS" -ne 0 ]; then
      echo "WARNING: cloudflared diagnostics failed. Check DNS resolution and outbound port 7844 (QUIC/HTTP2) before using live view." >&2
    fi
    cleanup_cloudflared_diagnostics
    trap - EXIT
    if rtsp_runtime_install_skipped; then
      : # Legacy cloudflared harness exercises only repository/diagnostic behavior.
    else
      install_rtsp_runtime
    fi
    echo "RTSP runtime installed; restart the worker supervisor to refresh its homeworker-stream group membership. Until then RTSP startup remains fail closed."
    echo "Experimental cloudflared live-stream capability installed."
    ;;
  digital)
    echo "Installing libgpiod CLI tools..."
    apt_get install -y gpiod
    if ! id -nG "$USER" | tr ' ' '\n' | grep -qx gpio; then
      sudo usermod -aG gpio "$USER"
    fi
    # A surviving pigpiod mmaps /dev/gpiomem and silently fights gpiod bias
    # settings without ever surfacing as a line consumer — stop and mask it.
    sudo systemctl disable --now pigpiod.service 2>/dev/null || true
    sudo systemctl mask pigpiod.service 2>/dev/null || true
    echo "Digital GPIO runtime installed; restart the worker supervisor to refresh its gpio group membership. Until then digital sensors remain unavailable."
    ;;
  *)
    echo "Unknown feature: $FEATURE" >&2
    exit 1
    ;;
esac
