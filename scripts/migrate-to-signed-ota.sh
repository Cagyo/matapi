#!/bin/bash
set -euo pipefail

usage() {
  echo "Usage: scripts/install.sh --fresh | --migrate --confirm" >&2
  exit 64
}

case "$#:$*" in
  "1:--fresh") MODE="fresh" ;;
  "2:--migrate --confirm") MODE="migrate" ;;
  *) usage ;;
esac

TEST_MODE="${HOME_WORKER_TEST_MODE:-0}"
FAIL_AT=""
if [[ "$TEST_MODE" == "1" ]]; then
  TEST_ROOT_INPUT="${HOME_WORKER_TEST_ROOT:-}"
  TEST_BIN_INPUT="${HOME_WORKER_TEST_BIN:-}"
  [[ "$TEST_ROOT_INPUT" == /* && -d "$TEST_ROOT_INPUT" && ! -L "$TEST_ROOT_INPUT" ]] || {
    echo "Guarded test mode requires an existing absolute HOME_WORKER_TEST_ROOT." >&2
    exit 64
  }
  TEST_ROOT="$(cd -- "$TEST_ROOT_INPUT" && pwd -P)"
  [[ "$TEST_ROOT" == "$TEST_ROOT_INPUT" ]] || {
    echo "HOME_WORKER_TEST_ROOT must already be canonical." >&2
    exit 64
  }
  case "$TEST_ROOT/" in
    /tmp/*/|/private/tmp/*/|/private/var/folders/*/) ;;
    *)
      echo "HOME_WORKER_TEST_ROOT must be a unique temporary root." >&2
      exit 64
      ;;
  esac
  [[ "$TEST_BIN_INPUT" == "$TEST_ROOT"/* && -d "$TEST_BIN_INPUT" && ! -L "$TEST_BIN_INPUT" ]] || {
    echo "HOME_WORKER_TEST_BIN must be a directory under the canonical test root." >&2
    exit 64
  }
  TEST_BIN="$(cd -- "$TEST_BIN_INPUT" && pwd -P)"
  [[ "$TEST_BIN" == "$TEST_BIN_INPUT" ]] || {
    echo "HOME_WORKER_TEST_BIN must already be canonical." >&2
    exit 64
  }

  INPUT_ROOT="$TEST_ROOT/inputs"
  INSTALL_ROOT="$TEST_ROOT/opt/home-worker"
  STATE_ROOT="$TEST_ROOT/var/lib/home-worker"
  ACTIVE_KEY="$INPUT_ROOT/active.pem"
  ACTIVE_KEY_FINGERPRINT="$INPUT_ROOT/active.sha256"
  POLICY="$INPUT_ROOT/ota-policy.json"
  BASELINE_ENVELOPE="$INPUT_ROOT/baseline-envelope.json"
  BASELINE_ARCHIVE="$INPUT_ROOT/baseline.tar.gz"
  PM2="$TEST_BIN/pm2"
  SYSTEMCTL="$TEST_BIN/systemctl"
  CHATTR="$TEST_BIN/chattr"
  for fake_command in "$PM2" "$SYSTEMCTL" "$CHATTR"; do
    [[ -f "$fake_command" && ! -L "$fake_command" && -x "$fake_command" ]] || {
      echo "Guarded test commands must be executable, non-symlink files under the canonical test root." >&2
      exit 64
    }
  done
  FAIL_AT="${HOME_WORKER_TEST_FAIL_AT:-}"
  TARGET_ARCH="${HOME_WORKER_TEST_TARGET_ARCH:-}"
  TARGET_NODE_MAJOR="${HOME_WORKER_TEST_NODE_MAJOR:-}"
  TARGET_NODE_ABI="${HOME_WORKER_TEST_NODE_ABI:-}"
  TARGET_LIBC_VERSION="${HOME_WORKER_TEST_LIBC_VERSION:-}"
else
  [[ "$TEST_MODE" == "0" ]] || {
    echo "HOME_WORKER_TEST_MODE must be 0 or 1." >&2
    exit 64
  }
  export PATH="/usr/sbin:/usr/bin:/sbin:/bin"
  INSTALL_ROOT="/opt/home-worker"
  STATE_ROOT="/var/lib/home-worker"
  ACTIVE_KEY="/etc/home-worker/update-keys/active/bootstrap.pem"
  ACTIVE_KEY_FINGERPRINT="/etc/home-worker/update-keys/active/bootstrap.sha256"
  POLICY="/etc/home-worker/ota-policy.json"
  BASELINE_ENVELOPE="/var/lib/home-worker/bootstrap/baseline-envelope.json"
  BASELINE_ARCHIVE="/var/lib/home-worker/bootstrap/baseline.tar.gz"
  PM2="/usr/bin/pm2"
  SYSTEMCTL="/usr/bin/systemctl"
  CHATTR="/usr/bin/chattr"
  TARGET_ARCH=""
  TARGET_NODE_MAJOR=""
  TARGET_NODE_ABI=""
  TARGET_LIBC_VERSION=""
fi

fail_gate() {
  echo "$1" >&2
  exit 75
}

inject_failure() {
  if [[ "$FAIL_AT" == "$1" ]]; then
    echo "Injected migration failure at $1." >&2
    return 75
  fi
}

require_regular_input() {
  local path="$1"
  local label="$2"
  local maximum="$3"
  local size

  [[ "$path" == /* ]] || fail_gate "$label path must be absolute."
  [[ -e "$path" ]] || fail_gate "Signed baseline/key bundle is incomplete: missing $label at $path. Provision the authenticated bootstrap artifacts produced by Tasks 16-18."
  [[ -f "$path" && ! -L "$path" ]] || fail_gate "$label must be a regular, non-symlink file."
  size="$(stat -f '%z' "$path" 2>/dev/null || stat -c '%s' "$path" 2>/dev/null)" || fail_gate "Cannot inspect $label."
  [[ "$size" =~ ^[0-9]+$ && "$size" -gt 0 && "$size" -le "$maximum" ]] || fail_gate "$label has an invalid size."
}

require_regular_input "$ACTIVE_KEY" "active public key" 16384
require_regular_input "$ACTIVE_KEY_FINGERPRINT" "active key fingerprint" 256
require_regular_input "$POLICY" "OTA policy" 1048576
require_regular_input "$BASELINE_ENVELOPE" "baseline envelope" 1048576
require_regular_input "$BASELINE_ARCHIVE" "baseline archive" 536870912
inject_failure preflight
[[ -d "$STATE_ROOT" && ! -L "$STATE_ROOT" ]] || fail_gate "Signed OTA state directory must already exist as a regular directory: $STATE_ROOT"
[[ -d "$(dirname -- "$INSTALL_ROOT")" && ! -L "$(dirname -- "$INSTALL_ROOT")" ]] || fail_gate "Install parent must already exist as a regular directory."
NODE_BIN="$(command -v node)" || fail_gate "Node.js is required for authenticated baseline validation."

if [[ "$MODE" == "migrate" ]]; then
  [[ -d "$INSTALL_ROOT" && ! -L "$INSTALL_ROOT" ]] || fail_gate "Migration requires the legacy install directory at $INSTALL_ROOT."
  "$NODE_BIN" - "$INSTALL_ROOT" <<'NODE' || fail_gate "Refusing unknown existing layout at the legacy install root."
const { lstatSync, readdirSync } = require("node:fs");
const root = process.argv[2];
const allowed = new Set([
  ".claudeignore", ".env", ".env.example", ".git", ".gitignore", ".impeccable",
  ".superpowers", ".yarn", ".yarnrc.yml", "AGENTS.md", "CLAUDE.md", "PRODUCT.md",
  "README.md", "config", "data", "dist", "docs", "drizzle.config.js",
  "drizzle.config.js.map", "drizzle.config.ts", "ecosystem.config.js", "eslint.config.mjs",
  "features.json", "installer", "migrations", "nest-cli.json", "node_modules", "package.json",
  "scripts", "src", "systemd", "test", "tsconfig.build.json", "tsconfig.eslint.json",
  "tsconfig.json", "vitest.config.ts", "yarn.lock",
]);
const names = readdirSync(root);
if (!names.includes("package.json") || !names.includes("dist")) process.exit(1);
for (const name of names) {
  if (!allowed.has(name) || lstatSync(`${root}/${name}`).isSymbolicLink()) process.exit(1);
}
if (!lstatSync(`${root}/package.json`).isFile() || !lstatSync(`${root}/dist`).isDirectory()) process.exit(1);
if (names.includes(".env") && !lstatSync(`${root}/.env`).isFile()) process.exit(1);
if (names.includes("data")) {
  if (!lstatSync(`${root}/data`).isDirectory()) process.exit(1);
  const walk = (directory) => {
    for (const name of readdirSync(directory)) {
      const path = `${directory}/${name}`;
      const info = lstatSync(path);
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) process.exit(1);
      if (info.isDirectory()) walk(path);
    }
  };
  walk(`${root}/data`);
}
NODE
else
  if [[ -e "$INSTALL_ROOT" ]]; then
    [[ -d "$INSTALL_ROOT" && ! -L "$INSTALL_ROOT" ]] || fail_gate "Fresh install path must be absent or an empty regular directory."
    [[ -z "$(find "$INSTALL_ROOT" -mindepth 1 -maxdepth 1 -print -quit)" ]] || fail_gate "Fresh install refuses a non-empty existing layout."
  fi
fi

TAR_BIN="$(command -v tar)" || fail_gate "tar is required for authenticated baseline validation."
DF_BIN="$(command -v df)" || fail_gate "df is required for capacity validation."

VALIDATION="$($NODE_BIN - "$ACTIVE_KEY" "$ACTIVE_KEY_FINGERPRINT" "$POLICY" "$BASELINE_ENVELOPE" "$BASELINE_ARCHIVE" "$TARGET_ARCH" "$TARGET_NODE_MAJOR" "$TARGET_NODE_ABI" "$TARGET_LIBC_VERSION" "$TEST_MODE" <<'NODE'
const { createHash, createPublicKey, verify } = require("node:crypto");
const { readFileSync, statSync } = require("node:fs");

const [keyPath, pinPath, policyPath, envelopePath, archivePath, archOverride, majorOverride, abiOverride, libcOverride, testMode] = process.argv.slice(2);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const exactKeys = (value, keys, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new Error(`${label} has unknown or missing fields`);
  }
};
const integer = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
};
const standardBase64 = (value, label) => {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error(`${label} is not canonical base64`);
  const result = Buffer.from(value, "base64");
  if (result.toString("base64") !== value) throw new Error(`${label} is not canonical base64`);
  return result;
};
const dottedAtLeast = (actual, minimum) => {
  const parse = (value) => {
    if (typeof value !== "string" || !/^\d+(?:\.\d+)*$/.test(value)) throw new Error("invalid libc version");
    return value.split(".").map(Number);
  };
  const a = parse(actual); const b = parse(minimum);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return true;
};

const keyBytes = readFileSync(keyPath);
const key = createPublicKey(keyBytes);
if (key.asymmetricKeyType !== "ed25519") throw new Error("active key must be Ed25519");
const keyId = sha256(key.export({ type: "spki", format: "der" }));
if (readFileSync(pinPath, "utf8") !== `${keyId}\n`) throw new Error("active key fingerprint mismatch");

const policyBytes = readFileSync(policyPath);
const policyText = policyBytes.toString("utf8");
const policyDocument = JSON.parse(policyText);
if (JSON.stringify(policyDocument) !== policyText) throw new Error("policy must use canonical JSON");
exactKeys(policyDocument, ["schemaVersion", "policy", "checksum"], "policy document");
if (policyDocument.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(policyDocument.checksum)) throw new Error("invalid policy envelope");
if (policyDocument.checksum !== sha256(JSON.stringify({ schemaVersion: 1, policy: policyDocument.policy }))) throw new Error("policy checksum mismatch");
const policy = policyDocument.policy;
exactKeys(policy, ["feedUrl", "channel", "target", "runtime", "limits"], "policy");
if (policy.channel !== "stable") throw new Error("policy channel must be stable");
exactKeys(policy.target, ["targetName", "platform", "arch", "libc", "libcVersion", "nodeModulesAbi"], "policy target");
exactKeys(policy.runtime, ["nodeMajor", "packageManager"], "policy runtime");
exactKeys(policy.limits, ["maxArtifactBytes", "maxExpandedBytes", "maxPreparedBytes", "maxPreparedFiles", "maxFiles"], "policy limits");
if (policy.target.platform !== "linux" || !["arm", "arm64"].includes(policy.target.arch) || policy.target.libc !== "glibc") throw new Error("unsupported policy target");
if (policy.target.targetName !== (policy.target.arch === "arm" ? "linux-armv7-glibc" : "linux-arm64-glibc")) throw new Error("invalid target name");
const feed = new URL(policy.feedUrl);
if (feed.protocol !== "https:" || feed.username || feed.password || feed.search || feed.hash || feed.pathname !== `/home-worker/stable/${policy.target.targetName}/update-envelope.json`) throw new Error("invalid stable feed URL");
if (policy.runtime.nodeMajor !== 20 || policy.runtime.packageManager !== "yarn@4.13.0") throw new Error("unsupported runtime policy");
const hardLimits = { maxArtifactBytes: 100 * 1024 * 1024, maxExpandedBytes: 512 * 1024 * 1024, maxPreparedBytes: 1024 * 1024 * 1024, maxPreparedFiles: 200_000, maxFiles: 20_000 };
for (const [name, maximum] of Object.entries(hardLimits)) {
  const value = policy.limits[name]; integer(value, `policy limit ${name}`);
  if (value === 0 || value > maximum) throw new Error("policy limit exceeds the hard ceiling");
}

const envelopeText = readFileSync(envelopePath, "utf8");
const envelope = JSON.parse(envelopeText);
if (JSON.stringify(envelope) !== envelopeText) throw new Error("baseline envelope must use canonical JSON");
exactKeys(envelope, ["payload", "signatures"], "baseline envelope");
if (!Array.isArray(envelope.signatures) || envelope.signatures.length < 1 || envelope.signatures.length > 3) throw new Error("invalid signature count");
const payloadBytes = standardBase64(envelope.payload, "baseline payload");
const seenSignatures = new Set();
for (const candidate of envelope.signatures) {
  exactKeys(candidate, ["keyId", "signature"], "signature");
  if (typeof candidate.keyId !== "string" || !/^[a-f0-9]{64}$/.test(candidate.keyId) || seenSignatures.has(candidate.keyId)) throw new Error("invalid or duplicate signature key id");
  seenSignatures.add(candidate.keyId);
  standardBase64(candidate.signature, "signature");
}
const signature = envelope.signatures.find((candidate) => candidate && candidate.keyId === keyId);
if (!signature) throw new Error("baseline is not signed by active key");
if (!verify(null, payloadBytes, key, standardBase64(signature.signature, "signature"))) throw new Error("baseline signature is invalid");
const payloadText = payloadBytes.toString("utf8");
const payload = JSON.parse(payloadText);
if (JSON.stringify(payload) !== payloadText) throw new Error("baseline payload must use canonical JSON");
exactKeys(payload, ["schemaVersion", "release", "channel", "target", "runtime", "policySha256", "artifact"], "baseline payload");
if (payload.schemaVersion !== 1 || payload.channel !== "stable" || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-[a-f0-9]{64}$/.test(payload.release)) throw new Error("invalid baseline identity");
if (payload.policySha256 !== sha256(policyBytes)) throw new Error("baseline policy digest mismatch");
exactKeys(payload.target, ["targetName", "platform", "arch", "libc", "libcMinVersion", "nodeModulesAbi"], "baseline target");
exactKeys(payload.runtime, ["nodeMajor", "packageManager"], "baseline runtime");
exactKeys(payload.artifact, ["sha256", "size", "expandedSize", "fileCount", "treeSha256", "requiredReserveBytes", "requiredReserveInodes"], "baseline artifact");
if (payload.target.targetName !== policy.target.targetName || payload.target.platform !== policy.target.platform || payload.target.arch !== policy.target.arch || payload.target.libc !== policy.target.libc || payload.target.nodeModulesAbi !== policy.target.nodeModulesAbi) throw new Error("baseline target differs from policy");
if (payload.runtime.nodeMajor !== policy.runtime.nodeMajor || payload.runtime.packageManager !== policy.runtime.packageManager) throw new Error("baseline runtime differs from policy");
for (const name of ["size", "expandedSize", "fileCount", "requiredReserveBytes", "requiredReserveInodes"]) integer(payload.artifact[name], `artifact ${name}`);
if (!/^[a-f0-9]{64}$/.test(payload.artifact.sha256) || !/^[a-f0-9]{64}$/.test(payload.artifact.treeSha256)) throw new Error("invalid artifact digest");
const archiveBytes = readFileSync(archivePath);
if (statSync(archivePath).size !== payload.artifact.size || sha256(archiveBytes) !== payload.artifact.sha256) throw new Error("baseline archive digest or size mismatch");
if (payload.artifact.size > policy.limits.maxArtifactBytes || payload.artifact.expandedSize > policy.limits.maxExpandedBytes || payload.artifact.fileCount > policy.limits.maxFiles || payload.artifact.fileCount > policy.limits.maxPreparedFiles || payload.artifact.expandedSize > policy.limits.maxPreparedBytes) throw new Error("baseline exceeds policy limits");

let runtime;
if (testMode === "1") {
  runtime = { arch: archOverride, nodeMajor: Number(majorOverride), abi: abiOverride, libcVersion: libcOverride };
} else {
  const report = process.report?.getReport?.().header;
  runtime = { arch: process.arch, nodeMajor: Number(process.versions.node.split(".")[0]), abi: process.versions.modules, libcVersion: report?.glibcVersionRuntime || "" };
}
if (runtime.arch !== policy.target.arch || runtime.nodeMajor !== policy.runtime.nodeMajor || runtime.abi !== policy.target.nodeModulesAbi || runtime.libcVersion !== policy.target.libcVersion || !dottedAtLeast(runtime.libcVersion, payload.target.libcMinVersion)) throw new Error("baseline does not match target Node/ABI/libc");
process.stdout.write([payload.artifact.expandedSize, payload.artifact.fileCount, payload.artifact.treeSha256, payload.artifact.requiredReserveBytes, payload.artifact.requiredReserveInodes].join("\t"));
NODE
)" || fail_gate "Authenticated baseline validation failed. Provision a genuine key/policy/baseline bundle from Tasks 16-18 before retrying."

IFS=$'\t' read -r EXPANDED_SIZE FILE_COUNT TREE_SHA RESERVE_BYTES RESERVE_INODES <<<"$VALIDATION"
AVAILABLE_KB="$($DF_BIN -Pk "$(dirname -- "$INSTALL_ROOT")" | awk 'NR==2 {print $4}')"
AVAILABLE_INODES="$($DF_BIN -Pi "$(dirname -- "$INSTALL_ROOT")" | awk 'NR==2 {print $4}')"
[[ "$AVAILABLE_KB" =~ ^[0-9]+$ && "$AVAILABLE_INODES" =~ ^[0-9]+$ ]] || fail_gate "Cannot determine available disk capacity."
REQUIRED_BYTES=$((EXPANDED_SIZE + RESERVE_BYTES))
(( AVAILABLE_KB * 1024 >= REQUIRED_BYTES )) || fail_gate "Insufficient disk reserve for the signed baseline."
(( AVAILABLE_INODES >= FILE_COUNT + RESERVE_INODES )) || fail_gate "Insufficient inode reserve for the signed baseline."

ARCHIVE_LIST="$($TAR_BIN -tzf "$BASELINE_ARCHIVE")" || fail_gate "Cannot inspect baseline archive."
while IFS= read -r entry; do
  entry="${entry#./}"
  [[ -z "$entry" ]] && continue
  [[ "$entry" != /* && "$entry" != ".." && "$entry" != ../* && "$entry" != */../* && "$entry" != */.. ]] || fail_gate "Baseline archive contains an unsafe path."
done <<<"$ARCHIVE_LIST"
$TAR_BIN -tvzf "$BASELINE_ARCHIVE" | awk '$1 !~ /^[-d]/ { exit 1 }' || fail_gate "Baseline archive contains links or special files."

MIGRATION_TEMP="$(mktemp -d "$STATE_ROOT/migration-XXXXXXXX")" || fail_gate "Cannot allocate migration staging directory."
[[ "$MIGRATION_TEMP" == "$STATE_ROOT"/migration-* && -d "$MIGRATION_TEMP" && ! -L "$MIGRATION_TEMP" ]] || fail_gate "Unsafe migration staging path."
BACKUP_ROOT="$STATE_ROOT/legacy-backup-${MIGRATION_TEMP##*-}"
[[ ! -e "$BACKUP_ROOT" ]] || fail_gate "Refusing an existing migration backup path."
STAGE_ROOT="$MIGRATION_TEMP/stage"
NEW_ROOT="$MIGRATION_TEMP/new-root"
LEGACY_MOVED=0
SWAPPED=0
POLLING_CHANGED=0
POLLING_WAS_ENABLED=0
WORKER_STOPPED=0
WORKER_PRIOR_STATE=""
COMPLETED=0

safe_remove_temp() {
  local path="$1"
  case "$path" in
    "$STATE_ROOT"/migration-*) rm -rf -- "$path" ;;
    *) echo "Refusing unsafe temporary cleanup path." >&2 ;;
  esac
}

compensate() {
  set +e
  if [[ "$SWAPPED" == "1" && -d "$INSTALL_ROOT" && ! -L "$INSTALL_ROOT" ]]; then
    "$CHATTR" -R -i "$INSTALL_ROOT" >/dev/null 2>&1 || true
    mv -- "$INSTALL_ROOT" "$MIGRATION_TEMP/failed-root"
  fi
  if [[ "$LEGACY_MOVED" == "1" && -d "$BACKUP_ROOT" && ! -L "$BACKUP_ROOT" ]]; then
    mv -- "$BACKUP_ROOT" "$INSTALL_ROOT"
  fi
  if [[ "$WORKER_PRIOR_STATE" == "running" && "$WORKER_STOPPED" == "1" && -d "$INSTALL_ROOT" ]]; then
    (cd -- "$INSTALL_ROOT" && "$PM2" start ecosystem.config.js) >/dev/null 2>&1 || true
  fi
  if [[ "$POLLING_CHANGED" == "1" ]]; then
    if [[ "$POLLING_WAS_ENABLED" == "1" ]]; then
      "$SYSTEMCTL" enable home-worker-update.timer >/dev/null 2>&1 || true
    else
      "$SYSTEMCTL" disable home-worker-update.timer >/dev/null 2>&1 || true
    fi
  fi
  safe_remove_temp "$MIGRATION_TEMP"
}

on_exit() {
  local status=$?
  trap - EXIT INT TERM
  if [[ "$COMPLETED" != "1" ]]; then
    compensate
  else
    safe_remove_temp "$MIGRATION_TEMP"
  fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 75' INT TERM

mkdir -- "$STAGE_ROOT"
$TAR_BIN -xzf "$BASELINE_ARCHIVE" -C "$STAGE_ROOT" --no-same-owner --no-same-permissions

ACTUAL_TREE="$($NODE_BIN - "$STAGE_ROOT" <<'NODE'
const { createHash } = require("node:crypto");
const { lstatSync, readFileSync, readdirSync } = require("node:fs");
const { join, relative } = require("node:path");
const root = process.argv[2];
const hash = createHash("sha256");
let files = 0;
let expanded = 0;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const visit = (directory) => {
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const info = lstatSync(path);
    const fromRoot = relative(root, path).split("\\").join("/");
    if (info.isDirectory()) { hash.update(`D\0${fromRoot}\0${info.mode & 0o777}\n`); visit(path); }
    else if (info.isFile()) { files += 1; expanded += info.size; hash.update(`F\0${fromRoot}\0${info.mode & 0o777}\0${info.size}\0${sha256(readFileSync(path))}\n`); }
    else process.exit(1);
  }
};
visit(root);
process.stdout.write(`${hash.digest("hex")}\t${files}\t${expanded}`);
NODE
)" || fail_gate "Cannot calculate baseline tree digest."
IFS=$'\t' read -r ACTUAL_TREE_SHA ACTUAL_FILES ACTUAL_EXPANDED <<<"$ACTUAL_TREE"
[[ "$ACTUAL_TREE_SHA" == "$TREE_SHA" && "$ACTUAL_FILES" == "$FILE_COUNT" && "$ACTUAL_EXPANDED" -le "$EXPANDED_SIZE" ]] || fail_gate "Baseline archive tree does not match the signed envelope."
inject_failure stage

if [[ "$TEST_MODE" != "1" ]]; then
  fail_gate "Authenticated baseline validated, but production signed-layout adoption remains disabled until Tasks 16-18 provide and approve the genuine Pi baseline/key bundle."
fi

mkdir -- "$NEW_ROOT"
mkdir -- "$NEW_ROOT/releases" "$NEW_ROOT/shared" "$NEW_ROOT/update"
mv -- "$STAGE_ROOT" "$NEW_ROOT/releases/baseline"
ln -s -- "releases/baseline" "$NEW_ROOT/current"

if "$SYSTEMCTL" is-enabled --quiet home-worker-update.timer; then
  POLLING_WAS_ENABLED=1
fi
PM2_LIST="$("$PM2" jlist)" || fail_gate "Cannot capture the prior PM2 worker state."
if ! WORKER_PRIOR_STATE="$($NODE_BIN -e '
const { readFileSync } = require("node:fs");
const source = readFileSync(0);
if (source.length > 4 * 1024 * 1024) process.exit(1);
const processes = JSON.parse(source.toString("utf8"));
if (!Array.isArray(processes)) process.exit(1);
const worker = processes.filter((entry) => entry?.name === "worker");
if (worker.length === 0) process.stdout.write("absent");
else if (worker.length !== 1) process.exit(1);
else if (worker[0]?.pm2_env?.status === "online") process.stdout.write("running");
else if (worker[0]?.pm2_env?.status === "stopped") process.stdout.write("stopped");
else process.exit(1);
' <<<"$PM2_LIST" 2>/dev/null)"; then
  fail_gate "Cannot validate the prior PM2 worker state."
fi
POLLING_CHANGED=1
"$SYSTEMCTL" disable home-worker-update.timer
if [[ "$WORKER_PRIOR_STATE" == "running" ]]; then
  if ! "$PM2" stop worker; then
    fail_gate "PM2 refused to stop the running legacy worker."
  fi
  WORKER_STOPPED=1
fi
inject_failure pm2-stop

if [[ "$MODE" == "migrate" ]]; then
  mkdir -- "$MIGRATION_TEMP/backup"
  cp -pR -- "$INSTALL_ROOT/data" "$MIGRATION_TEMP/backup/data"
  cp -p -- "$INSTALL_ROOT/package.json" "$MIGRATION_TEMP/backup/package.json"
  [[ ! -f "$INSTALL_ROOT/.env" ]] || cp -p -- "$INSTALL_ROOT/.env" "$MIGRATION_TEMP/backup/.env"
  cp -pR -- "$MIGRATION_TEMP/backup/data" "$NEW_ROOT/data"
  [[ ! -f "$MIGRATION_TEMP/backup/.env" ]] || cp -p -- "$MIGRATION_TEMP/backup/.env" "$NEW_ROOT/.env"
else
  mkdir -- "$NEW_ROOT/data"
fi
inject_failure backup

if [[ "$MODE" == "migrate" ]]; then
  mv -- "$INSTALL_ROOT" "$BACKUP_ROOT"
  LEGACY_MOVED=1
elif [[ -d "$INSTALL_ROOT" ]]; then
  rmdir -- "$INSTALL_ROOT"
fi
mv -- "$NEW_ROOT" "$INSTALL_ROOT"
SWAPPED=1
"$CHATTR" -R +i "$INSTALL_ROOT/releases/baseline"
inject_failure swap
inject_failure pm2-start
(cd -- "$INSTALL_ROOT/current" && "$PM2" start ecosystem.config.js)
WORKER_STOPPED=0
COMPLETED=1
echo "Signed OTA layout staged successfully under guarded test mode."
