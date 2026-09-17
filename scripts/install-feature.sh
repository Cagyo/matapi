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

# Exit statuses 20-23 remain the closed contract with the root feature
# installer. Policy selection and legacy parsing no longer happen in this
# shell: the fixed live-view applier owns every durable policy write.
RTSP_EXIT_NO_LOCAL_NETWORK=20
RTSP_EXIT_POLICY_GENERATION=21
RTSP_EXIT_DEPENDENCY=22
RTSP_EXIT_PRIVILEGED=23

apt_get() {
  sudo apt-get -o "DPkg::Lock::Timeout=${APT_LOCK_TIMEOUT_SECONDS}" "$@"
}

install_root_asset_if_distinct() {
  local source="$1" target="$2" mode="$3"
  # The privileged routine normally executes from the already-validated root
  # bundle, so an executable whose fixed source and target match needs no copy.
  [ "$source" = "$target" ] && return 0
  sudo install -m "$mode" -o root -g root "$source" "$target"
}

rtsp_runtime_install_skipped() {
  [ "${HOME_WORKER_RTSP_SKIP_RUNTIME_INSTALL:-0}" = "1" ] && [ "${VITEST:-}" = "true" ]
}

install_rtsp_runtime() {
  local stream_user="homeworker-stream"
  local stream_group="homeworker-stream"

  if ! [[ "$USER" =~ ^[a-z_][a-z0-9_-]*$ ]]; then
    echo "ERROR: unsafe worker account name" >&2
    return 1
  fi

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

  # Provision the fixed worker credential through the validated root helper.
  # The helper preserves a valid key byte-for-byte and never returns its value.
  if ! sudo /usr/lib/home-worker/feature-installer --provision-rtsp-credentials; then
    return "$RTSP_EXIT_PRIVILEGED"
  fi

  # The root-only applier runs last. Until it has published and activated a
  # generation-bound deny-all policy, no installed RTSP feature is reported as
  # ready by the root helper.
  if ! apt_get install -y ffmpeg nftables polkitd pkexec; then
    return "$RTSP_EXIT_DEPENDENCY"
  fi

  sudo install -d -m 0755 -o root -g root /etc/home-worker /etc/home-worker/ca \
    /usr/lib/home-worker /etc/polkit-1/rules.d /etc/tmpfiles.d
  install_root_asset_if_distinct \
    "$SCRIPT_DIR/live-stream-ffmpeg-runner" \
    /usr/lib/home-worker/live-stream-ffmpeg-runner \
    0755
  sudo install -m 0644 -o root -g root \
    "$ROOT_BUNDLE_DIR/systemd/homeworker-ffmpeg-stream@.service" \
    /etc/systemd/system/homeworker-ffmpeg-stream@.service
  sudo install -m 0644 -o root -g root \
    "$ROOT_BUNDLE_DIR/systemd/homeworker-stream-net.service" \
    /etc/systemd/system/homeworker-stream-net.service

  local polkit_tmp
  polkit_tmp="$(mktemp)"
  sed "s/@HOME_WORKER_USER@/$USER/g" \
    "$ROOT_BUNDLE_DIR/systemd/homeworker-stream-systemd.rules" > "$polkit_tmp"
  sudo install -m 0644 -o root -g root "$polkit_tmp" \
    /etc/polkit-1/rules.d/49-homeworker-stream-systemd.rules
  rm -f "$polkit_tmp"

  local tmpfiles_tmp
  tmpfiles_tmp="$(mktemp)"
  cat > "$tmpfiles_tmp" <<EOF
d /run/home-worker 0750 root $stream_group - -
d /run/home-worker/live-stream-config 2730 root $stream_group - -
d /run/home-worker/live-stream-output 3770 root $stream_group - -
d /run/home-worker/live-source-probe 0700 $USER $USER - -
EOF
  sudo install -m 0644 -o root -g root "$tmpfiles_tmp" \
    /etc/tmpfiles.d/homeworker-stream.conf
  rm -f "$tmpfiles_tmp"
  sudo systemd-tmpfiles --create /etc/tmpfiles.d/homeworker-stream.conf
  sudo systemctl daemon-reload
  sudo systemctl enable homeworker-stream-net.service

  if ! sudo /usr/lib/home-worker/live-view-policy-applier --bootstrap-rtsp; then
    return "$RTSP_EXIT_PRIVILEGED"
  fi
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
        exit "$RTSP_EXIT_DEPENDENCY"
        ;;
    esac

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
          exit "$RTSP_EXIT_DEPENDENCY"
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

      apt_get update || exit "$RTSP_EXIT_DEPENDENCY"
      apt_get install -y cloudflared || exit "$RTSP_EXIT_DEPENDENCY"
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
      exit "$RTSP_EXIT_DEPENDENCY"
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
