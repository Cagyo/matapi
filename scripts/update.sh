#!/bin/bash
# OTA update — fetches release tarball from GitHub Releases (with git fetch fallback),
# snapshots current state to data/rollbacks/, uses prebuilt dist/ from release
# tarballs but rebuilds dist/ on the git fallback path, migrates, pm2-restarts,
# then runs a post-restart health check. On failure restores from rollback
# snapshot, reinstalls, restarts again, and lets the worker surface the outcome
# via the `update_status` flag in system_meta on next boot.
#
# Spec 13 (/update) + spec 24 (OTA).
set -euo pipefail

INSTALL_DIR="${HOME_WORKER_INSTALL_DIR:-/opt/home-worker}"
LOCKFILE="${HOME_WORKER_UPDATE_LOCK:-/tmp/home-worker-updating.lock}"
APP_NAME="${PM2_APP_NAME:-worker}"
HEALTH_CHECK_SEC="${UPDATE_HEALTH_CHECK_SEC:-30}"
FEATURE_HELPER="/usr/lib/home-worker/feature-installer"
FEATURE_HELPER_VERSION="/usr/lib/home-worker/feature-installer.version"
FEATURE_HELPER_MANIFEST="/usr/lib/home-worker/feature-installer.manifest"

helper_update_required() {
  echo "helper-update-required: root feature-management artifacts are missing or stale." >&2
  echo "Run the trusted root installer (scripts/install.sh) locally to deploy the matching /usr/lib/home-worker helper bundle, then retry the update." >&2
  # The script runs detached with stdio ignored — surface the guidance through
  # the worker instead: restart_reason drives the RestartConfirmationService
  # broadcast on next boot. The update was refused, so the running code is
  # unchanged and safe to restart.
  write_meta "restart_reason" "ota_helper_update_required" 2>/dev/null || true
  pm2 restart "$APP_NAME" >/dev/null 2>&1 || true
  exit 3
}

require_valid_feature_helper() {
  [[ -x "$FEATURE_HELPER" && -r "$FEATURE_HELPER_VERSION" && -r "$FEATURE_HELPER_MANIFEST" ]] || helper_update_required
  # The executable is root-owned and independently validates every manifest
  # entry. This update process intentionally has no sudo capability.
  "$FEATURE_HELPER" --validate-installation >/dev/null 2>&1 || helper_update_required
}

require_feature_helper_version() {
  local expected="$1"
  [[ "$expected" =~ ^[0-9]+$ ]] || helper_update_required
  require_valid_feature_helper
  [[ "$(cat "$FEATURE_HELPER_VERSION" 2>/dev/null || true)" == "$expected" ]] || helper_update_required
}

candidate_helper_version() {
  local file="$1"
  tr -d '\r\n' < "$file" 2>/dev/null || true
}

configured_database_path() {
  if [[ -n "${DATABASE_PATH:-}" ]]; then
    printf '%s\n' "$DATABASE_PATH"
    return
  fi

  local configured_path
  configured_path="$(
    sed -n -E 's/^[[:space:]]*DATABASE_PATH[[:space:]]*=[[:space:]]*//p' "$INSTALL_DIR/.env" 2>/dev/null |
      tail -n 1 |
      sed -E 's/[[:space:]]*$//' || true
  )"

  printf '%s\n' "${configured_path:-$INSTALL_DIR/data/worker.db}"
}

DB_PATH="$(configured_database_path)"

# Write key/value into system_meta. Uses sqlite3 if available, otherwise
# falls back to better-sqlite3 via a tiny node one-liner.
write_meta() {
  local key="$1"
  local value="$2"
  if command -v sqlite3 >/dev/null 2>&1; then
    local esc_key=${key//"'"/"''"}
    local esc_value=${value//"'"/"''"}
    sqlite3 "$DB_PATH" "INSERT INTO system_meta(key, value) VALUES('$esc_key', '$esc_value') ON CONFLICT(key) DO UPDATE SET value=excluded.value;"
  else
    KEY="$key" VAL="$value" DBP="$DB_PATH" INST="$INSTALL_DIR" node -e "const Database=require(process.env.INST+'/node_modules/better-sqlite3');const db=new Database(process.env.DBP);db.prepare('INSERT INTO system_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(process.env.KEY,process.env.VAL);db.close();"
  fi
}

if [[ -e "$LOCKFILE" ]]; then
  echo "Update already in progress (lockfile $LOCKFILE exists)" >&2
  exit 2
fi
echo "$$" > "$LOCKFILE"
trap 'rm -f "$LOCKFILE"' EXIT

cd "$INSTALL_DIR"
require_valid_feature_helper

install_production_deps() {
  echo "Configuring low-memory Yarn settings in $INSTALL_DIR/.yarnrc.yml..."
  cat <<'YAML' | tee "$INSTALL_DIR/.yarnrc.yml" >/dev/null
networkConcurrency: 4
compressionLevel: 0
enableGlobalCache: true
enableProgressBars: false
nodeLinker: node-modules
nmMode: hardlinks-global
YAML

  echo "Installing production dependencies with single-threaded job limits (jobs=1)..."
  export NODE_OPTIONS="--max-old-space-size=512"
  export npm_config_jobs=1
  export JOBS=1
  env NODE_OPTIONS="$NODE_OPTIONS" npm_config_jobs=1 JOBS=1 corepack yarn workspaces focus -A --production
}

# Default branch of origin (main/master/...). Returns nonzero when undetectable.
default_branch() {
  local head
  head="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || true)"
  if [[ -z "$head" ]]; then
    git remote set-head origin --auto >/dev/null 2>&1 || true
    head="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || true)"
  fi
  if [[ -n "$head" && "$head" == origin/* ]]; then
    echo "${head#origin/}"
    return 0
  fi
  for candidate in master main; do
    if git rev-parse --verify "origin/$candidate" >/dev/null 2>&1; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

# Rebuild dist/ from source. Git updates ship no dist (it is gitignored), so
# restarting without this step re-runs the OLD code while reporting success.
# Same low-memory discipline as install_production_deps — the full dev-deps
# install + nest build is the most OOM-prone step this script runs on a 1GB Pi.
# The explicit `|| return 1` lines matter: this runs inside `if ! build_dist`,
# which suspends errexit within the function.
build_dist() {
  echo "Building dist/ from source (git update path)..."
  export NODE_OPTIONS="--max-old-space-size=512"
  export npm_config_jobs=1
  export JOBS=1
  corepack yarn install --immutable || return 1
  corepack yarn build || return 1
  # Slim node_modules back to production (also refreshes the low-memory
  # .yarnrc.yml that install_production_deps maintains).
  install_production_deps
}

# True when ecosystem.config.js declares an app called "$1".
ecosystem_declares_app() {
  local answer
  answer="$(
    node -e 'const apps=require(process.argv[1]).apps||[];process.stdout.write(apps.some((app)=>app&&app.name===process.argv[2])?"yes":"no")' \
      "$INSTALL_DIR/ecosystem.config.js" "$1" 2>/dev/null || true
  )"
  [[ "$answer" == "yes" ]]
}

# Restart the worker so that ecosystem.config.js is re-evaluated.
#
# `pm2 restart <name>` replays the process's stored pm2_env and never re-reads
# the config file, and `pm2 resurrect` on boot replays dump.pm2, which is the
# same stale snapshot. Restart-policy changes shipped by an update (min_uptime,
# restart_delay, max_restarts — spec 23) would therefore never reach a device
# through OTA. Restarting from the config file applies them to the live process.
restart_worker() {
  if ! ecosystem_declares_app "$APP_NAME"; then
    # `--only` with a name the file does not declare restarts nothing and still
    # exits 0, which would hand the health check a stale-but-online process and
    # call the update a success. Fall back to the by-name restart instead.
    pm2 restart "$APP_NAME"
    return
  fi

  # `pm2 <cmd> <config file>` always updates the app's environment (the JSON
  # path forces it; there is no opt-out) by baking in the *caller's* environment
  # — and `pm2 save` below then persists that across reboots. This script's
  # environment carries the OTA control knobs (DATABASE_PATH, HOME_WORKER_*,
  # UPDATE_HEALTH_CHECK_SEC) plus the build-time NODE_OPTIONS/JOBS exports, and
  # `dotenv` never overrides an already-set variable, so baking them in would
  # silently shadow .env forever. Restart under a scrubbed environment holding
  # only what PM2 itself needs: PATH, and HOME/PM2_HOME so the CLI reaches the
  # same daemon the health check below queries — scrubbing those would let the
  # restart address a different daemon, where `--only` matches nothing.
  local -a scrubbed=(env -i "PATH=$PATH")
  local passthrough
  for passthrough in HOME PM2_HOME; do
    if [[ -n "${!passthrough:-}" ]]; then
      scrubbed+=("$passthrough=${!passthrough}")
    fi
  done
  # Absolute path so the config's `cwd: ... || __dirname` resolves to
  # "$INSTALL_DIR" exactly as it does during a fresh install.
  "${scrubbed[@]}" pm2 startOrRestart "$INSTALL_DIR/ecosystem.config.js" --update-env --only "$APP_NAME"
}

# Prints "<status> <restart_time>" for $APP_NAME, or "unknown unknown".
pm2_app_state() {
  pm2 jlist 2>/dev/null | APP_NAME="$APP_NAME" node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{try{const apps=JSON.parse(s);const app=apps.find(a=>a.name===process.env.APP_NAME);process.stdout.write(app?app.pm2_env.status+' '+app.pm2_env.restart_time:'missing unknown');}catch(_){process.stdout.write('unknown unknown');}});" || echo "unknown unknown"
}

rollback_to_snapshot() {
  local identifier="$1"
  local git_ref="${2:-}"
  echo "Rolling back to $identifier..." >&2
  if [[ -n "$git_ref" && -d "$INSTALL_DIR/.git" ]] && git rev-parse "$git_ref" >/dev/null 2>&1; then
    git reset --hard "$git_ref" || true
  fi
  if [[ -f "$identifier" ]]; then
    tar -xzf "$identifier" -C "$INSTALL_DIR" || true
  elif [[ -d "$INSTALL_DIR/.git" ]] && git rev-parse "$identifier" >/dev/null 2>&1; then
    git reset --hard "$identifier" || true
  else
    local newest
    newest="$(ls -t "$INSTALL_DIR/data/rollbacks"/rollback-*.tar.gz 2>/dev/null | head -1 || true)"
    if [[ -n "$newest" ]]; then
      tar -xzf "$newest" -C "$INSTALL_DIR" || true
    fi
  fi
  install_production_deps || true
  write_meta "restart_reason" "ota_update_failed"
  write_meta "update_status" "failed"
  # By name, not from the config file: this is the get-the-service-back-up path,
  # and the ecosystem.config.js on disk has just been reverted to the previous
  # release's. Reusing the loaded pm2_env keeps the restart policy that is
  # already in force and keeps this path to its single moving part.
  pm2 restart "$APP_NAME" || true
}

# Create rollback snapshot before updating
mkdir -p "$INSTALL_DIR/data/rollbacks"
ROLLBACK_SNAPSHOT="$INSTALL_DIR/data/rollbacks/rollback-$(date +%s).tar.gz"
echo "Creating pre-update rollback snapshot: $ROLLBACK_SNAPSHOT..."
tar -czf "$ROLLBACK_SNAPSHOT" --exclude="data" --exclude="node_modules" --exclude=".git" -C "$INSTALL_DIR" .

# Prune old rollback snapshots (retain only 3 most recent)
ls -t "$INSTALL_DIR/data/rollbacks"/rollback-*.tar.gz 2>/dev/null | tail -n +4 | xargs -I {} rm -f "{}" || true

# Determine if updating via GitHub Release tarball or Git fallback
REPO_URL="${HOME_WORKER_REPO:-}"
if [[ -z "$REPO_URL" ]] && [[ -d "$INSTALL_DIR/.git" ]]; then
  REPO_URL="$(git -C "$INSTALL_DIR" config --get remote.origin.url || true)"
fi

RELEASE_URL="${HOME_WORKER_RELEASE_URL:-}"
if [[ -z "$RELEASE_URL" ]] && [[ -n "$REPO_URL" ]]; then
  CLEAN_URL="$(echo "$REPO_URL" | sed -E 's#^git@github\.com:#https://github.com/#; s#\.git$##')"
  if [[ "$CLEAN_URL" != "https://github.com/CHANGE_ME/home-worker" ]]; then
    RELEASE_URL="${CLEAN_URL}/releases/latest/download/home-worker-release.tar.gz"
  fi
fi

UPDATED_VIA="git"
NEW_COMMIT=""
CURRENT_COMMIT=""
ROLLBACK_TAG=""

LOCAL_SOURCE="${HOME_WORKER_REPO#file://}"
if [[ -n "${HOME_WORKER_REPO:-}" ]] && [[ -d "$LOCAL_SOURCE" ]] && [[ "$LOCAL_SOURCE" != "$INSTALL_DIR" ]] && [[ -f "$LOCAL_SOURCE/package.json" ]]; then
  require_feature_helper_version "$(candidate_helper_version "$LOCAL_SOURCE/config/feature-installer.version")"
  echo "Syncing local development update from $LOCAL_SOURCE over $INSTALL_DIR..."
  rsync -av --delete --exclude="data" --exclude="node_modules" --exclude=".git" --exclude=".yarn" --exclude=".env" --exclude=".env.*" --exclude="features.json" "$LOCAL_SOURCE/" "$INSTALL_DIR/"
  UPDATED_VIA="local"
  NEW_COMMIT="dev-$(date +%s)"
elif [[ -n "$RELEASE_URL" ]] && curl --output /dev/null --silent --head --fail "$RELEASE_URL" 2>/dev/null; then
  echo "Downloading release tarball from $RELEASE_URL..."
  TMP_TAR="/tmp/home-worker-release.tar.gz"
  STAGING_DIR="/tmp/home-worker-staging-$$"
  rm -rf "$STAGING_DIR" "$TMP_TAR"
  
  if curl -fsSL "$RELEASE_URL" -o "$TMP_TAR" && tar -tzf "$TMP_TAR" >/dev/null 2>&1; then
    mkdir -p "$STAGING_DIR"
    tar -xzf "$TMP_TAR" -C "$STAGING_DIR"
    require_feature_helper_version "$(candidate_helper_version "$STAGING_DIR/config/feature-installer.version")"
    echo "Syncing staged release over $INSTALL_DIR..."
    rsync -av --delete --exclude="data" --exclude="node_modules" --exclude=".git" "$STAGING_DIR/" "$INSTALL_DIR/"
    rm -rf "$STAGING_DIR" "$TMP_TAR"
    UPDATED_VIA="tarball"
    NEW_COMMIT="release-$(date +%s)"
  else
    echo "WARNING: Failed to download or verify release tarball from $RELEASE_URL. Falling back to git..."
    rm -rf "$STAGING_DIR" "$TMP_TAR"
  fi
fi

if [[ "$UPDATED_VIA" == "git" ]]; then
  if [[ ! -d "$INSTALL_DIR/.git" ]]; then
    echo "ERROR: Cannot perform OTA update: No release tarball available and $INSTALL_DIR is not a git repository." >&2
    rm -f "$ROLLBACK_SNAPSHOT"
    exit 1
  fi
  CURRENT_COMMIT="$(git rev-parse HEAD)"
  git fetch origin
  # Same resolution order as ShellOtaAdapter: explicit pin beats detection,
  # so the apply path can never target a different branch than the check did.
  if [[ -n "${HOME_WORKER_GIT_BRANCH:-}" ]]; then
    BRANCH="$HOME_WORKER_GIT_BRANCH"
  elif ! BRANCH="$(default_branch)"; then
    echo "ERROR: cannot determine origin default branch" >&2
    rollback_to_snapshot "$ROLLBACK_SNAPSHOT"
    exit 1
  fi
  REMOTE_COMMIT="$(git rev-parse "origin/$BRANCH")"
  if [[ "$CURRENT_COMMIT" == "$REMOTE_COMMIT" ]]; then
    echo "Already up to date"
    rm -f "$ROLLBACK_SNAPSHOT"
    exit 0
  fi
  CANDIDATE_HELPER_VERSION="$(git show "$REMOTE_COMMIT:config/feature-installer.version" 2>/dev/null | tr -d '\r\n' || true)"
  require_feature_helper_version "$CANDIDATE_HELPER_VERSION"
  ROLLBACK_TAG="rollback-$(date +%s)"
  git tag "$ROLLBACK_TAG" "$CURRENT_COMMIT"
  git reset --hard "origin/$BRANCH"
  NEW_COMMIT="$(git rev-parse HEAD)"
fi

write_meta "restart_reason" "ota_update"
write_meta "update_commit" "$NEW_COMMIT"
write_meta "update_rollback_snapshot" "$ROLLBACK_SNAPSHOT"

if [[ "$UPDATED_VIA" == "git" ]]; then
  if ! build_dist; then
    echo "build failed, rolling back" >&2
    rollback_to_snapshot "$ROLLBACK_SNAPSHOT" "${ROLLBACK_TAG:-$CURRENT_COMMIT}"
    exit 1
  fi
else
  if ! install_production_deps; then
    echo "production dependencies install failed, rolling back" >&2
    rollback_to_snapshot "$ROLLBACK_SNAPSHOT"
    exit 1
  fi
fi
if ! corepack yarn db:migrate; then
  echo "migrations failed, rolling back" >&2
  rollback_to_snapshot "$ROLLBACK_SNAPSHOT" "${ROLLBACK_TAG:-$CURRENT_COMMIT}"
  exit 1
fi

write_meta "update_status" "pending"
# Baseline taken *before* the restart on purpose: the reading then cannot race
# PM2's own bookkeeping for the restart we are about to ask for, whichever side
# of the CLI ack that counter happens to move on.
RESTART_BASELINE="$(pm2_app_state | cut -d' ' -f2)"
if ! restart_worker; then
  echo "restart failed, rolling back" >&2
  rollback_to_snapshot "$ROLLBACK_SNAPSHOT" "${ROLLBACK_TAG:-$CURRENT_COMMIT}"
  exit 1
fi

# Post-restart health check. The restart returns as soon as PM2 has launched the
# process; give the worker HEALTH_CHECK_SEC seconds to come back online.
sleep "$HEALTH_CHECK_SEC"
APP_STATE="$(pm2_app_state)"
STATUS="${APP_STATE%% *}"
RESTART_COUNT="${APP_STATE##* }"

if [[ "$STATUS" != "online" ]]; then
  echo "Health check failed (pm2 status=$STATUS), rolling back" >&2
  rollback_to_snapshot "$ROLLBACK_SNAPSHOT" "${ROLLBACK_TAG:-$CURRENT_COMMIT}"
  exit 1
fi

# A crash-looping deploy can still read `online` at the instant we sample it:
# restart_delay keeps most of each cycle in `waiting restart`, but a worker that
# survives ~25 s is `online` most of the time. PM2's restart counter is the
# deterministic signal. One increment is the restart we asked for; anything
# beyond that is the new build dying and PM2 bringing it back. The check is
# skipped whenever either reading is non-numeric, so a `pm2 jlist` hiccup can
# never trigger a rollback on its own.
if [[ "$RESTART_BASELINE" =~ ^[0-9]+$ && "$RESTART_COUNT" =~ ^[0-9]+$ ]] &&
   (( RESTART_COUNT > RESTART_BASELINE + 1 )); then
  echo "Health check failed (worker restarted $((RESTART_COUNT - RESTART_BASELINE - 1))x after the update restart), rolling back" >&2
  rollback_to_snapshot "$ROLLBACK_SNAPSHOT" "${ROLLBACK_TAG:-$CURRENT_COMMIT}"
  exit 1
fi

# Persist the freshly evaluated pm2_env so the next boot's `pm2 resurrect`
# replays this restart policy and not the pre-update one. Deliberately after the
# health check: a failed update must never be written into dump.pm2.
pm2 save >/dev/null 2>&1 ||
  echo "warning: pm2 save failed; the restart policy will not survive a reboot" >&2

write_meta "update_status" "success"
echo "Update complete: $NEW_COMMIT"
