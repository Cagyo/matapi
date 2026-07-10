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
DB_PATH="${DATABASE_PATH:-$INSTALL_DIR/data/worker.db}"

if [[ -e "$LOCKFILE" ]]; then
  echo "Update already in progress (lockfile $LOCKFILE exists)" >&2
  exit 2
fi
echo "$$" > "$LOCKFILE"
trap 'rm -f "$LOCKFILE"' EXIT

cd "$INSTALL_DIR"

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
  CLEAN_URL="$(echo "$REPO_URL" | sed -E 's|^(git@github\.com:|https://github\.com/)|https://github.com/|; s|\.git$||')"
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
pm2 restart "$APP_NAME"

# Post-restart health check. pm2 restart returns immediately; give the
# worker HEALTH_CHECK_SEC seconds to come back online.
sleep "$HEALTH_CHECK_SEC"
STATUS="$(APP_NAME="$APP_NAME" pm2 jlist 2>/dev/null | node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{try{const apps=JSON.parse(s);const app=apps.find(a=>a.name===process.env.APP_NAME);process.stdout.write(app?app.pm2_env.status:'missing');}catch(_){process.stdout.write('unknown');}});" || echo unknown)"

if [[ "$STATUS" != "online" ]]; then
  echo "Health check failed (pm2 status=$STATUS), rolling back" >&2
  rollback_to_snapshot "$ROLLBACK_SNAPSHOT" "${ROLLBACK_TAG:-$CURRENT_COMMIT}"
  exit 1
fi

write_meta "update_status" "success"
echo "Update complete: $NEW_COMMIT"
