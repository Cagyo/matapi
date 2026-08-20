# Public Signed OTA Release Feed

> **Date:** 2026-07-18
> **Status:** revised after two adversarial reviews; awaiting final approval
> **Scope:** replace Git-based production update discovery and unsigned release downloads with a public, signed HTTP release feed for Raspberry Pi workers

## 1. Goal and decisions

Each Raspberry Pi checks a public website for a newer application release without holding GitHub credentials or update-site credentials. A Pi installs a release only when it proves that trusted release metadata authorized the exact archive, the archive matches the signed size and hash, and the complete candidate passes local installation and health checks.

The approved choices are:

- release metadata and archives are public and require no download authentication;
- authenticity uses Ed25519 signatures rooted in public keys provisioned separately from the update website;
- hourly polling discovers and notifies only; it never installs automatically;
- `/update` installs the exact release identity shown to the administrator;
- production installations have no Git credentials and need no `.git` directory;
- releases are prepared in versioned directories and activated atomically;
- the Pi keeps the current and previous known-good releases for rollback.

## 2. Security model

The design protects against:

- a compromised update website, CDN, DNS path, or network replacing metadata or archives;
- replay of older signed metadata, silent update freezing beyond a bounded expiry window under the stated trustworthy-time assumption, and automatic downgrade attempts;
- truncated, transformed, oversized, or corrupted downloads;
- archive traversal, unsafe entry types, duplicate paths, and decompression resource exhaustion;
- interruption or power loss during download, installation, activation, or health checking;
- a compromised general build job substituting bytes that do not reproduce from the operator-approved source commit;
- a compromised Pi gaining permission to publish releases.

The design does not hide the application. JavaScript in `dist/`, migrations, package metadata, dependency archives, and operational scripts must be treated as public. Release archives must never contain `.env*`, tokens, databases, logs, device configuration, private keys, captured media, or other runtime state.

The signing private key is the root of trust. A signing-key compromise permits malicious releases until the compromised public key is manually revoked on each Pi. Automated remote root-key recovery and threshold signing are outside this design; basic overlapping-key rotation is supported as described below.

A fully compromised Pi can modify its own files and execution. Local-host compromise resistance is not a goal. The design limits that compromise to the device, does not turn the recovery path into a privilege-escalation primitive, and prevents the device from becoming release-publishing authority.

Expiry provides a bounded freeze window only while the Pi has trustworthy time. The HTTP/DNS attacker in this model cannot also control the configured time trust anchor. A deployment that relies only on unauthenticated network time must treat bounded freeze detection across reboot as conditional, not absolute. The client still persists a last-trusted-time floor and rejects clock rollback so loss of that external assumption fails visibly rather than silently lowering time.

## 3. Trust bootstrap and key lifecycle

The update website is never trusted to bootstrap its own verification key.

The installer receives at least one Ed25519 public key through one of these authenticated paths:

1. the key is embedded in an installer bundle whose SHA-256 fingerprint the operator verifies out of band; or
2. the operator copies the key to the Pi over an already authenticated administrative channel and verifies its fingerprint.

The installer writes trusted keys beneath:

```text
/etc/home-worker/update-keys/
  active/<key-id>.pem
  retired/<key-id>.pem
```

The directories and keys are owned by `root:root`; directories are `0755` and key files are `0644`. The `homeworker` service account can read but cannot replace them. `key-id` is the lowercase SHA-256 digest of the DER-encoded SPKI public key.

The feed verifier reads only `active/`, parses each configured key with `createPublicKey`, requires `asymmetricKeyType === 'ed25519'`, and ignores malformed, unknown, duplicate, or non-Ed25519 keys. New metadata verification succeeds only when at least one signature from an active key is valid. The recovery launcher may additionally use `retired/`, but only to verify the immutable first-authorizing envelope of an already local artifact with a matching durable known-good marker and observed-ledger entry. A retired key can never advance metadata, authorize a download, prepare a new directory, or turn an unknown local directory into known-good state.

Manual rotation uses an overlap:

1. provision the new public key on every Pi through the authenticated administrative path;
2. publish envelopes signed by both old and new keys;
3. verify fleet acceptance of the new key;
4. atomically move the old key from `active/` to `retired/` on each Pi;
5. stop producing the old signature;
6. remove the retired key only after neither `current` nor `previous` depends solely on an envelope signed by it.

The private key is never stored in the repository, website, general build job, independent verifier, or Pi. For a single-operator deployment, the recommended publisher is an encrypted offline signing key. If CI signing is used, a protected signing job requires human approval, verifies the independent reproducibility attestation, does not check out or execute repository code, recomputes the artifact hash itself, and uses a non-exportable signing key where available.

## 4. On-device release layout

Application code is immutable after release preparation:

```text
/opt/home-worker/
  current -> releases/1.4.2-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef/
  previous -> releases/1.4.1-708ed2e991ef708ed2e991ef708ed2e991ef708ed2e991ef708ed2e991ef708e/
  releases/
    1.4.1-708ed2e991ef708ed2e991ef708ed2e991ef708ed2e991ef708ed2e991ef708e/
    1.4.2-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef/
  shared/
    data/
    .env
    features.json
    update/
      trusted-state-a.json
      trusted-state-b.json
      operation-a.json
      operation-b.json
```

The installer owns the exact persistent-path map. Runtime state is stored only under `shared/`; installer-created links expose required shared paths inside each release directory. Links are not supplied by the release archive.

PM2 always launches `/opt/home-worker/current/dist/main.js`. Candidate dependencies are installed within the candidate release, so switching `current` also switches application code, package metadata, scripts, migrations, the pinned Yarn runtime, and `node_modules` as one release unit.

`/usr/local/lib/home-worker/ota-recover.mjs` is a minimal installer-owned recovery launcher outside the service-writable application tree. It is root-owned, is not replaced by application OTA, and is invoked as the unprivileged `homeworker` account by the system service before PM2 resurrection. Root ownership protects the launcher; it does not grant the launcher root execution. The launcher reconciles the dual-slot operation journal and symlinks even when the selected application release cannot start. Normal updates to this launcher require an authenticated maintenance installation, not an application release.

Activation creates a temporary symlink in `/opt/home-worker`, calls `fsync` on required files and directories, and renames the temporary link over `current` on the same filesystem. The operation journal records the prior `current` and `previous` targets before activation. `previous` is updated to the prior `current` target only after the candidate passes health checking. The old release is retained throughout.

Release-directory names are derived only from immutable artifact identity: application version plus the full artifact SHA-256. Metadata refreshes never create a second directory for identical artifact bytes, and directory selection never relies on a truncated-digest collision check.

Each prepared release contains `artifact-state.json` and `artifact-envelope.json`, written by the updater rather than read from the archive. They record the immutable artifact identity, preparation target, preparation time, and the first verified envelope that authorized those bytes. After health succeeds, the updater adds `known-good.json` with the artifact identity and health timestamp. These files become immutable after the known-good marker is durable. The active symlink target plus `artifact-state.json` is the source of truth for installed bytes; the shared operation state records which metadata identity authorized the latest activation. `system_meta` mirrors both identities for Telegram reporting but is not authoritative.

## 5. Published resources

The update origin exposes two unauthenticated HTTPS resources:

```text
/home-worker/stable/linux-arm64-glibc/update-envelope.json
/home-worker/releases/home-worker-1.4.2-linux-arm64-glibc.tar.gz
```

The authenticated maintenance installer selects exactly one compiled update target, such as `linux-arm64-glibc` or `linux-armv7-glibc`, and configures its target-specific feed. Artifacts are immutable and versioned per target. Reusing an artifact URL for different bytes is a publishing failure.

The mutable update envelope is one file so payload and signatures cannot be observed from different publication generations:

```json
{
  "payload": "e30=",
  "signatures": [
    {
      "keyId": "0000000000000000000000000000000000000000000000000000000000000000",
      "signature": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="
    }
  ]
}
```

This is a structural example only; its zero signature is not valid. `payload` is canonical Base64 containing the exact UTF-8 manifest bytes. Each detached Ed25519 signature covers those decoded payload bytes, not the outer envelope serialization. Verification calls `crypto.verify(null, payloadBytes, publicKey, signatureBytes)` after confirming the key type.

The outer envelope is bounded to 96 KiB and contains exactly `payload` and `signatures`. `signatures` contains one to three entries with no duplicate key IDs. Each entry contains exactly `keyId` and `signature`; `keyId` is 64 lowercase hexadecimal characters, and `signature` is canonical padded Base64 that decodes to exactly 64 bytes.

The server publishes the envelope with `Cache-Control: no-cache, must-revalidate, no-transform` and a strong `ETag`. Versioned archives use `Cache-Control: public, max-age=31536000, immutable, no-transform`.

## 6. Signed manifest contract

```json
{
  "schemaVersion": 1,
  "metadataVersion": 42,
  "channel": "stable",
  "version": "1.4.2",
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "publishedAt": "2026-07-18T12:00:00Z",
  "expiresAt": "2026-08-17T12:00:00Z",
  "target": {
    "platform": "linux",
    "arch": "arm64",
    "libc": "glibc",
    "libcMinVersion": "2.28",
    "nodeModulesAbi": "115"
  },
  "artifact": {
    "url": "https://updates.example.com/home-worker/releases/home-worker-1.4.2-linux-arm64-glibc.tar.gz",
    "format": "tar.gz",
    "size": 52428800,
    "expandedSize": 209715200,
    "maxPreparedSize": 805306368,
    "maxPreparedFiles": 120000,
    "fileCount": 8500,
    "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  },
  "runtime": {
    "nodeMajor": 20,
    "packageManager": "yarn@4.13.0"
  }
}
```

Validation rules:

- the decoded payload is at most 64 KiB, valid UTF-8 under fatal decoding, and has no BOM;
- JSON objects have no duplicate or unknown keys;
- `schemaVersion` equals `1`; unknown schemas fail closed;
- `metadataVersion` is a positive safe integer;
- a lower metadata version is a rollback attack;
- the same metadata version with a different payload digest is a metadata-equivocation failure;
- `channel` is at most 32 ASCII characters and exactly matches the configured channel;
- `version` is an ASCII SemVer release of at most 64 characters without build metadata;
- the `stable` channel rejects prerelease SemVer versions;
- `commit` is exactly 40 lowercase hexadecimal characters and is traceability data only;
- timestamps are strict RFC 3339 UTC values, `publishedAt < expiresAt`, and validity is no longer than 31 days;
- `publishedAt` cannot exceed the fixed effective check-start time by more than five minutes;
- `expiresAt` must be later than the fixed effective check-start time;
- `target.platform`, `target.arch`, `target.libc`, and `target.nodeModulesAbi` exactly match the installer-pinned target and running platform, and the runtime libc version is at least the strict numeric dotted `target.libcMinVersion` built on the oldest supported image;
- `artifact.url` contains no credentials or fragment, uses HTTPS, and has the same normalized origin as the configured feed URL;
- `artifact.format` equals `tar.gz`;
- sizes, prepared-size and prepared-file bounds, and counts are positive safe integers within configured hard limits;
- `artifact.sha256` is exactly 64 lowercase hexadecimal characters;
- `runtime.nodeMajor` equals the installed Node major version;
- `runtime.packageManager` equals the compiled exact package-manager version accepted by the installed updater; after download, the bundled runtime must report that exact version and match the verified archive/cache inventory.

Trusted state also enforces release immutability: once an application version and target pair has been observed, a later metadata refresh using that pair must retain the same artifact URL, format, compressed/expanded/prepared sizes, archive/prepared counts, and digest. The ledger value hashes a fixed-field canonical encoding of exactly those artifact properties rather than general JSON serialization. Changed bytes require a new application version. A signed application version lower than the installed application version is never an update; only the explicit local rollback operation may activate it.

The publisher may refresh metadata without changing the application release. A refresh increments `metadataVersion`, advances `publishedAt` and `expiresAt`, and retains the same application version and artifact identity. Publication monitoring must refresh the envelope before expiry.

Metadata expiry requires a trustworthy clock. The clock-sync port must report synchronized time before a new envelope becomes trusted or an update starts. The client derives an effective check time that never precedes its persisted last-trusted-time floor, rejects wall-clock rollback beyond five minutes, and advances time from a monotonic clock while the current boot remains running. An unsynchronized or rolled-back clock leaves the current release running, fails closed for installation, and reports a clock-specific diagnostic. Across a reboot on hardware without a trusted RTC, expiry remains conditional on the external time trust assumption stated in the security model.

## 7. Parser, transport, and resource bounds

Configuration:

```text
HOME_WORKER_UPDATE_FEED_URL=https://updates.example.com/home-worker/stable/linux-arm64-glibc/update-envelope.json
HOME_WORKER_UPDATE_TRUST_DIR=/etc/home-worker/update-keys/active
HOME_WORKER_UPDATE_CHANNEL=stable
HOME_WORKER_UPDATE_TARGET=linux-arm64-glibc
HOME_WORKER_UPDATE_POLL_MINUTES=60
HOME_WORKER_UPDATE_MAX_ARTIFACT_BYTES=104857600
HOME_WORKER_UPDATE_MAX_EXPANDED_BYTES=536870912
HOME_WORKER_UPDATE_MAX_PREPARED_BYTES=1073741824
HOME_WORKER_UPDATE_MAX_FILES=20000
HOME_WORKER_UPDATE_MAX_PREPARED_FILES=200000
HOME_WORKER_UPDATE_HEALTH_SECONDS=60
```

The feed URL, trust directory, and installer-pinned target are required in production, and the target must match the feed path. Other values default as shown and are parsed as bounded positive integers during startup; malformed values are configuration failures rather than permissive fallbacks.

Defaults are configurable downward but cannot be raised beyond compiled hard ceilings:

```text
envelope response       96 KiB
decoded manifest        64 KiB
signature count          3
decoded signature       64 bytes
compressed artifact    100 MiB
expanded archive       512 MiB
prepared candidate       1 GiB
archive entries         20,000
prepared entries       200,000
single regular file     64 MiB
normalized path        240 UTF-8 bytes
redirects                3
```

Envelope and signature Base64 use the standard alphabet with required padding. Validation uses a strict regular expression, length check, decode, and encode-round-trip equality. It does not rely on Node's permissive `Buffer.from(value, 'base64')` alone.

HTTP behavior:

- only `200`, conditional `304`, and explicitly handled failure statuses are accepted;
- redirects are followed manually and every hop must remain on the configured HTTPS origin;
- requests send `Accept-Encoding: identity`; any non-identity content encoding is rejected;
- archive SHA-256 and size cover the exact identity response-body bytes written to disk;
- response bodies are streamed, bounded, and always consumed or cancelled;
- connect, first-byte, idle-body, and total-request timeouts are independent;
- retryable failures use capped exponential backoff with jitter;
- `206 Partial Content` is rejected because resumable downloads are outside this design.

Temporary directories are created with an unpredictable name and mode `0700`. Files are opened exclusively with mode `0600` and no symlink following. Cleanup runs on success, ordinary failure, and termination; startup recovery removes abandoned preparation directories that are not referenced by the selected operation-journal slot.

Before downloading, the updater verifies that the destination filesystem has space and free inodes for the compressed artifact, declared expansion, signed maximum prepared size and file count, the current and previous releases, and fixed safety headroom. A fully allocated, non-sparse, durable 128 MiB emergency-reserve file remains unavailable to candidate preparation; if free space nevertheless crosses the runtime low-water mark, the updater releases that reserve, aborts preparation, removes the incomplete candidate, and recreates and re-verifies the reserve after space is recovered. Prepared-directory allocated bytes, entry count, filesystem free space, and free inodes are enforced throughout extraction and dependency installation, not only during preflight. Disk or inode pressure fails before the running service is stopped.

## 8. Architecture and boundaries

The existing `system` bounded context remains responsible for OTA behavior.

The application layer uses these concepts:

- `ArtifactIdentity`: target, application version, commit, artifact URL, format, sizes, file count, and artifact hash;
- `MetadataIdentity`: metadata version, channel, payload digest, published time, and expiry;
- `CheckedReleaseIdentity`: the exact `ArtifactIdentity` plus the `MetadataIdentity` that authorized it;
- `UpdateCheck`: `current`, `available`, or typed failure, including the exact available `CheckedReleaseIdentity`;
- `OtaPort.checkForUpdates()`: verifies and persists trusted metadata without modifying the live release;
- `OtaPort.startUpdate(expected: CheckedReleaseIdentity)`: starts only the exact checked authorization and returns after an atomic updater lock/operation receipt is established;
- `OtaPort.startRollback()`: activates the local previous known-good release without consulting Git or the remote feed;
- a signed HTTP release-feed adapter for transport, envelope verification, strict parsing, expiry, and trusted-state persistence;
- a detached updater for artifact verification, candidate preparation, activation, health checking, and recovery.

The installer-owned recovery launcher is deliberately smaller than the application updater. It performs no network access, metadata advancement, extraction, dependency installation, migration, or health checking. It validates the durable operation journal and local artifact identities, reverses any activation that was not durably marked healthy, and finalizes already-healthy state before PM2 starts.

The recovery launcher treats journal content as hostile input. Every journal-supplied target must be a canonical single child of `/opt/home-worker/releases`, must match its artifact-derived directory name, and must pass `lstat` and no-symlink-follow ownership checks. Cleanup, rename, and symlink operations use directory-relative handles and cannot address `shared/`, `/etc`, or any path outside the release root. The PM2 system unit retains `User=homeworker`; an implementation that would execute journal-driven recovery as root is rejected.

The operation journal, preparation receipt, `artifact-state.json`, `known-good.json`, and pending startup-report receipt use installer-owned, bounded `schemaVersion: 1` contracts shared by the application updater, preparation unit, recovery launcher, and boot reporter. Application OTA may add only explicitly ignorable fields. New phases, changed meanings, or a new schema require an authenticated maintenance update of the installer-owned components before an application release may emit them. A signed-manifest schema that the installed recovery launcher cannot parse likewise requires maintenance before adoption.

Check scheduling uses process-local single-flight protection. Apply and rollback share a kernel-owned `flock` lock at `/run/home-worker/ota.lock`; systemd creates `/run/home-worker` for the service account. The kernel releases the lock when the owning process exits, so crashes do not leave a permanent stale lock. The check-then-spawn lockfile pattern is removed.

The preparation unit additionally owns `/run/home-worker/ota-prepare.lock` for its entire cgroup lifetime. Every updater and recovery cleanup checks this lease after acquiring `ota.lock`; if preparation still owns it, the caller reports an operation in progress and does not inspect, reuse, or delete any candidate. If the updater dies, the sandbox keeps the preparation lease until systemd has terminated its full control group. The next updater first waits for that lease to release, reconciles the durable operation receipt, and only then starts new work.

The updater is executed from the current immutable release. Versioned activation never overwrites that release while the updater is running. `startUpdate` passes the expected identity and waits for an explicit child handshake confirming that the updater acquired the lock and durably created its operation receipt before reporting “started.”

Every update or rollback has a bounded random operation ID. The Telegram application stores the mapping from that ID to its authorized workflow receipt in the database; filesystem journals never contain Telegram user IDs or chat IDs. A worker-side operation monitor reports terminal failures that occur before PM2 is stopped. Once PM2 has been stopped, the updater or recovery launcher records a pending startup-report receipt and the next successful worker boot reports the terminal outcome idempotently. Immediate check/authorization failures return synchronously; post-handshake outcomes arrive through this receipt path.

## 9. Trusted state

Trusted state uses alternating `trusted-state-a.json` and `trusted-state-b.json` slots with monotonically increasing local generations and a checksum over the canonical slot content to detect non-adversarial corruption. Each slot is written with a temporary file, file `fsync`, atomic rename, and parent-directory `fsync`; the older valid slot is retained until the newer slot is durable. A slot contains:

- highest verified `metadataVersion` and its payload digest;
- the last verified envelope bytes and their strong `ETag`;
- the highest accepted effective wall time, boot ID, and boot-monotonic anchor used to detect clock rollback;
- an observed-artifact ledger keyed by channel, target, and application version and storing the digest of the canonical artifact identity;
- the last notified application version;
- failure-notification rate-limit state.

State is untrusted input on read, is checksum- and schema-validated, and has a compiled 2 MiB slot limit. Signed envelope verification remains authoritative. Recovery selects the highest valid local generation and requires its highest metadata version and payload digest to exactly match the stored signed envelope; that envelope's artifact identity must also match its ledger entry. The observed-artifact ledger has a compiled maximum of 1,024 entries, is never silently evicted, and fails closed into authenticated maintenance if exhausted. A monotonic anchor is reused only when its recorded boot ID matches the running boot. If both state slots are missing or corrupt, the updater enters a `trust-state-lost` failure and requires authenticated operator recovery. Current and previous release envelopes can prove installed identities but cannot reconstruct the highest metadata version, trusted-time floor, or full artifact ledger, so an unconditional feed response is never allowed to reset those floors.

On `304 Not Modified`, the Pi re-verifies the envelope stored in the selected state slot, validates it against the persisted highest metadata version, and checks expiry. If the envelope is absent, corrupt, unverifiable, or expired, the Pi retries once without `If-None-Match`. A still-expired envelope is reported as a potential freeze or publishing failure.

The fixed effective update-check time is captured once after clock synchronization and rollback checks and reused for all expiry checks in that check cycle. Its floor is persisted whenever metadata advances or effective time has advanced at least six hours since the last durable floor, including on a valid `304` or a network failure after successful clock validation, so routine reboots cannot repeatedly return to a month-old local floor.

## 10. Discovery and notification flow

Automatic checks run every 60 minutes with up to five minutes of startup jitter. They never overlap and never install an update.

1. Confirm synchronized system time.
2. Fetch the envelope conditionally when a complete cache exists.
3. Enforce response bounds and transport policy.
4. Strictly parse the outer envelope and decoded payload.
5. Load trusted Ed25519 public keys and verify at least one recognized signature.
6. Validate manifest schema, target, origin, runtime compatibility, metadata monotonicity, artifact immutability, effective time, and expiry.
7. Atomically persist the new trusted metadata state.
8. Resolve the installed identity from the `current` release directory.
9. If the signed application version is newer, notify administrators once for that version.
10. If the version is current, report current without notification, even when metadata was refreshed.

Routine network failures retain the current release and are logged without Telegram noise while the last trusted metadata remains unexpired. Once cached trusted metadata expires, continuing network failure becomes an administrator-visible freeze-or-unavailability condition, rate-limited by distinct failure identity and day. Signature, equivocation, rollback, expiry, or trust-root failures are also administrator-visible under the same rate limit.

The manual `/update` command performs the same check, displays the exact application version, target, and short commit, and calls `startUpdate` with that `CheckedReleaseIdentity`. If the cached envelope no longer matches that authorization, the updater aborts and asks the administrator to check again; it never silently substitutes a newer release.

## 11. Apply and activation flow

1. Atomically acquire the kernel update lock and durably create the first operation-journal slot with the expected identity, prior `current` and `previous` targets, candidate target, and phase `preparing`.
2. Load the envelope from the selected trusted-state slot, then re-verify its signature, expiry, metadata monotonicity, and exact expected identity.
3. Preflight filesystem space, exact target, and runtime compatibility.
4. Download the immutable archive into the private temporary directory while streaming its SHA-256 and enforcing exact compressed size.
5. Require the actual digest and byte count to equal the signed values.
6. Inspect the archive structurally and enforce all extraction rules and expanded-resource limits.
7. Resolve the artifact-addressed release directory. If it does not exist, create it exclusively and extract on the same filesystem as `current`. If a matching known-good directory already exists, verify its immutable artifact identity and prepared-tree digest and reuse it without extraction or dependency installation. An incomplete unreferenced directory may be removed and rebuilt; a mismatching known-good directory is a maintenance failure and is never overwritten.
8. Verify the bundled Yarn runtime and target-specific offline cache are present. Structurally inspect every cache ZIP, bound its entries and declared uncompressed bytes, reject encrypted, traversing, duplicate, malformed, or unsupported entries, and require aggregate inner counts and sizes to fit the signed prepared bounds. Then install production dependencies inside a network- and secret-isolated preparation service using immutable-cache settings and Pi job/memory limits.
9. After dependency installation exits, create installer-owned links to the exact persistent runtime paths.
10. For a new candidate, write `artifact-state.json` and `artifact-envelope.json`, compute the prepared-tree digest, durably flush the entire candidate tree, and only then mark the operation phase `prepared`. For a reused known-good candidate, leave its immutable files unchanged, reference its verified existing tree digest, and mark the new operation `prepared`.
11. Stop the existing PM2 worker and wait for confirmed process exit so migrations cannot race the old process.
12. Run the candidate's compiled `dist/migrate.js` against the shared database. Migration failure must be transactional or safely retryable.
13. Mark the operation `activating`, atomically switch `current`, and then durably mark the operation `activated` before starting the candidate.
14. Remove any old readiness marker and start PM2 against `current`.
15. Capture the first candidate PID and restart counter produced by the intentional PM2 start before accepting `online`. Require a readiness marker from that exact PID containing the operation ID plus expected artifact and metadata digests, no PID replacement or restart-counter increase at any point, and stable uptime for 60 seconds.
16. For a newly prepared candidate, write and `fsync` `known-good.json` with the prepared-tree digest and `fsync` its parent directory; for a reused release, require the existing marker to remain unchanged. Then durably mark the operation `healthy` with the same operation ID, candidate PID, artifact digest, metadata digest, tree digest, and health timestamp. Update `previous` to the recorded prior `current`, mirror both installed artifact and activating metadata identities to `system_meta`, retain both known-good releases, and prune older releases only after all state is durable.
17. Notify administrators of success through the existing restart-confirmation path.

The readiness marker is `/run/home-worker/ready.json`, written atomically by the worker after configuration loading, database access, idempotent startup migration verification, and required local module initialization succeed. External Telegram, cloud, or internet availability is not part of local release health.

The signed release archive includes:

- prebuilt `dist/`;
- migrations and required operational scripts;
- `package.json`, the dependency lockfile, `.yarnrc.yml`, and required workspace metadata;
- the exact Yarn 4.13 runtime under `.yarn/releases/`;
- a clean, target-specific production dependency cache under `.yarn/cache/`.

The on-device Yarn configuration sets `nodeLinker: node-modules`, `enableGlobalCache: false`, `enableNetwork: false`, `enableOfflineMode: false`, `enableImmutableCache: true`, and exact `supportedArchitectures.os`, `.cpu`, and `.libc` lists derived from the signed target. The updater invokes the bundled Yarn release directly with the installed Node runtime, never global Yarn or Corepack. It uses a fixed clean environment and private empty home directory so user configuration and `YARN_*` or npm registry environment overrides cannot alter policy. The updater records hashes of `package.json`, the lockfile, `.yarnrc.yml`, the bundled Yarn runtime, and a canonical cache inventory containing each relative path, size, and SHA-256 before and after `yarn workspaces focus -A --production`; any mutation fails preparation. `workspaces focus` does not support an `--immutable` flag, so the design does not claim otherwise.

Native lifecycle builds run with `jobs=1`, `MemoryMax=512M`, bounded tasks and runtime, `KillMode=control-group`, and the existing process limits inside an installer-owned systemd preparation unit. The unit is root-owned but uses `User=homeworker`, `PrivateNetwork=yes`, `RestrictAddressFamilies=AF_UNIX`, `NoNewPrivileges=yes`, `ProtectHome=yes`, a read-only system view, and write access only to the candidate and its private temporary directory. `/opt/home-worker/shared`, the PM2 home, runtime `.env`, databases, device configuration, logs, and media are inaccessible during preparation; persistent links are created only after the unit exits and systemd confirms no descendant remains. Before activation, the updater validates the durable journal and writes a minimal operation-ID, candidate-name, and identity projection beneath `/run/home-worker/prepare/`; the sandbox resolves only that projection and never sees `shared/`. The updater may request only this fixed unit through a maintenance-installed receipt-only activation rule. The unit accepts a bounded random operation ID and never accepts an arbitrary path or command. It holds the global preparation lease until the whole control group is gone. Yarn network settings provide a second fail-closed layer; the operating-system sandbox is what prevents lifecycle scripts such as `prebuild-install` from fetching unverified bytes.

`dist/migrate.js` is a compiled production entrypoint using the runtime Drizzle migrator and the signed SQL migration directory. OTA does not depend on `drizzle-kit`, `drizzle.config.ts`, TypeScript source, or development dependencies at runtime. The same migration coordinator runs idempotently during worker startup before readiness is published.

Candidate durability is a separate invariant from symlink atomicity. After extraction, dependency installation, links, state files, and the prepared-tree digest are complete, the updater flushes every regular file and every mutated directory in the candidate and performs a filesystem-level durability barrier before writing the durable `prepared` journal generation. A process kill and a real power cut after `prepared` must both recover a byte-complete candidate; otherwise activation is forbidden.

The prepared-tree digest canonically covers every release-relative path, entry type, normalized mode, regular-file byte digest, and updater-created link target. It excludes `artifact-state.json`, `artifact-envelope.json`, and `known-good.json` to avoid self-reference, and never follows links into `shared/`. The known-good marker binds that tree digest to the immutable artifact identity.

## 12. Archive extraction policy

Inspection uses structured tar metadata, not parsing human-formatted `tar -t` output. The archive may contain only directories and regular files.

The updater rejects:

- absolute, empty, dot, or parent-traversing normalized paths;
- symbolic links, hard links, devices, FIFOs, sockets, sparse files, and unrecognized/PAX types;
- NUL, control characters, invalid UTF-8, overlong paths, or paths resolving outside the candidate root;
- duplicate normalized paths and duplicate entries that would overwrite earlier content;
- setuid, setgid, sticky, group-writable, or world-writable modes;
- entry count, individual size, or cumulative expanded size above configured limits;
- an archive whose actual entry count or expanded regular-file bytes differ from the signed manifest.

Ownership is never restored from the archive. The updater assigns the service account and normalizes directories to `0755`, ordinary files to `0644`, and only an explicit script allowlist to `0755`.

Extraction occurs only in a new private directory. Any validation or extraction failure removes the incomplete candidate without modifying `current` or stopping the worker.

## 13. Rollback and interruption recovery

Rollback is local and does not re-fetch the feed. Expired metadata does not invalidate a previously installed known-good release.

`/rollback`:

1. acquires the same kernel update lock;
2. resolves and validates `previous`, its `artifact-state.json`, known-good marker, and prepared-tree digest;
3. records a rollback operation with both symlink targets and uses the same `activating`, `activated`, and operation-bound `healthy` phase semantics as update activation;
4. stops PM2 and waits for exit, atomically switches `current` to the previous release, durably marks `activated`, and starts it;
5. applies the same first-PID, operation-ID, restart-counter, readiness, and stable-uptime health check using artifact and tree digests; remote metadata and expiry are not inputs;
6. durably marks the rollback operation `healthy`, updates `previous` to the release that was active before rollback, and mirrors the now-active artifact identity to `system_meta`;
7. restores both original symlink targets and restarts the original release if rollback health checking fails.

Repeated rollback does not keep selecting the same directory accidentally: after a successful rollback, `previous` is updated to the release that was active before rollback, making the operation reversible.

The operation journal uses alternating `operation-a.json` and `operation-b.json` slots with monotonically increasing local generations, canonical-content checksums, and the same file/directory `fsync` discipline as trusted state. At boot, the recovery launcher selects the highest valid generation:

- `preparing` or `prepared` with unchanged `current` removes only an incomplete, unreferenced candidate; a matching reusable known-good directory is preserved;
- `cleanup_pending` waits for the preparation lease, removes only validated operation-owned temporary or incomplete paths, recreates the emergency reserve, and then records the corresponding terminal failure;
- `activating` or `activated` always restores the recorded prior `current` and `previous` targets before PM2 starts; an artifact-level `known-good.json` from an earlier activation is never evidence that the current operation passed health;
- `healthy` requires health evidence bound to the same operation ID plus a matching artifact-level known-good marker, then finalizes symlinks and deferred pruning idempotently and records a pending startup-report receipt; missing or mismatched evidence restores the recorded prior targets instead;
- terminal `failed_pre_activation`, `rolled_back`, and `rollback_failed` states preserve their safe typed result without further filesystem mutation; the live operation monitor or next-boot reporter owns delivery and idempotent acknowledgement;
- if both operation slots are corrupt, recovery selects `current` only when it has a valid known-good marker; otherwise it selects a valid known-good `previous`; if neither exists, it leaves PM2 stopped and requires authenticated maintenance.

The installer-owned recovery launcher runs these checks as `homeworker` before PM2 resurrection, so recovery does not depend on either application release reaching Nest bootstrap. It validates local artifact identity against the stored first-authorizing signed envelope and the prepared-tree digest, but does not apply remote expiry rules to an already installed known-good release. It has no SQLite or candidate dependency and never updates `system_meta`; the first successful worker startup consumes the pending receipt, mirrors identities idempotently, and sends the terminal notification.

Power loss is tested after every durable phase transition. Temporary paths, candidate releases, and symlinks are never selected solely by modification time.

Database migrations remain forward-only, idempotently detectable, safely retryable after interruption, and backward-compatible with the immediately previous release because code rollback does not reverse a successfully committed database migration.

## 14. Initial migration to the release layout

The existing in-place `/opt/home-worker` installation cannot safely convert itself to the new trust root and directory layout through the legacy unsigned updater.

Adoption is a one-time authenticated maintenance operation:

1. stop PM2;
2. back up the current application and database using the existing operational backup procedure;
3. provision and verify the initial update public key out of band;
4. install the root-owned recovery and preparation launchers plus systemd units that execute their application-facing work as `homeworker`;
5. create `shared/`, move existing runtime state into it, and validate ownership and permissions;
6. select and pin the device target, install its verified baseline release under the artifact-addressed `releases/` path, write its local artifact identity files, and seed both trusted-state slots from its signed envelope;
7. create `current`, omit `previous` until a second known-good release exists, and point PM2 at `current`;
8. start the worker, require the full readiness check, write the baseline known-good marker, and retain the pre-migration backup until the first feed update succeeds.

If any step fails, the maintenance installer restores the pre-migration layout and does not enable feed polling. Subsequent application updates use only the signed feed workflow.

## 15. Release publishing

Publishing is split into an untrusted candidate build, an independent reproducibility verifier, and a protected signing/publication stage. The three stages use separate credentials and workers. Operator approval pins the full source commit, application version, target, and proposed artifact digest.

### Untrusted candidate build

1. Build and test the exact operator-selected tagged revision for one target.
2. Require the tag, full commit, `package.json` version, requested release version, and target to match.
3. Starting from an empty project cache, populate and validate the target-specific production Yarn cache and pinned Yarn runtime.
4. Assemble a deterministic archive with sorted paths, normalized ownership, timestamps, and permissions.
5. Reject secrets, runtime state, links, special files, unexpected top-level paths, and files outside the release allowlist.
6. Structurally inspect all Yarn cache ZIPs, then measure prepared allocated bytes and entry count on the target build image and add fixed conservative headroom before enforcing compiled ceilings.
7. Compute compressed size, expanded regular-file bytes, maximum prepared size and file count, archive file count, and SHA-256.
8. Produce the unsigned manifest input and immutable candidate outputs.

### Independent reproducibility verification

1. Fetch the operator-pinned full commit through an authenticated source channel; do not accept source or commit identity from the candidate builder.
2. Build in a fresh ephemeral target environment. Dependency acquisition runs with lifecycle builds skipped and network access limited to the locked registry inputs; network is then disabled before application build and all package lifecycle execution.
3. Reproduce the archive using the same deterministic packaging rules and independently regenerate the target-specific cache inventory.
4. Require byte-for-byte archive digest equality with the candidate output and exact agreement on version, commit, target, archive and prepared sizes/counts, lockfile, cache inventory, and Yarn runtime.
5. Emit a signed verification attestation binding the approved commit, application version, target, artifact digest, measured properties, lockfile digest, cache inventory digest, and Yarn runtime digest. A mismatch stops publication and cannot be overridden by the general build job.

### Protected signing and publication stage

1. Require explicit approval displaying the full commit, version, target, artifact digest, and independent verification result.
2. Do not check out or execute repository code or archive contents.
3. Verify the independent attestation, recompute archive hash and sizes, and re-run non-executing structural policy checks. Construct the canonical manifest from the approved values, attested commit/target, protected counter, measured artifact properties, and configured immutable URL; never sign manifest bytes supplied by the candidate builder.
4. Allocate the next metadata version from a protected durable channel-and-target counter using serialized compare-and-swap. Failed or concurrent publications never reuse a version.
5. Generate an expiry no more than 31 days away and sign the exact manifest bytes with each active protected Ed25519 key.
6. Upload the immutable target-specific archive first and refuse to overwrite an existing URL.
7. Fetch the public archive independently and verify its size and hash.
8. Atomically replace the target-specific update envelope last.
9. Fetch and verify the public envelope and artifact relationship through the CDN path.
10. Monitor envelope expiry and refresh signed metadata before it expires, even when no application release changes. Refreshes pass through the same protected counter and signing path but may reuse the previously verified artifact attestation.

Website upload credentials, independent-verifier authority, and signing authority remain separate. The hosting backend must provide whole-object atomic replacement for the mutable envelope; publication is unsupported on a backend that can expose partial object writes. Compromising the website, upload account, or general builder alone cannot produce a trusted release.

## 16. Failure behavior and observability

Before activation, every failure leaves the current process and symlink unchanged. After activation, failure restores the recorded prior target and restarts it.

Before releasing its locks, every terminal path completes or durably delegates operation-owned temporary/candidate cleanup and emergency-reserve recreation, then records the operation ID, terminal phase, typed failure code, safe bounded diagnostic fields, and whether delivery belongs to the live monitor or next-boot reporter. A crash before that terminal write leaves a nonterminal phase for recovery to reconcile; a cleanup that cannot complete remains an explicit `cleanup_pending` phase rather than falsely becoming terminal. Stack traces, response bodies, environment values, and interface identifiers are never written to the journal.

Typed failures distinguish:

- clock unsynchronized, rolled back, or conditionally untrustworthy across reboot;
- network unavailable, timeout, redirect, or HTTP status failure;
- envelope too large or malformed;
- trust key missing or invalid;
- signature invalid;
- metadata rollback, equivocation, freeze/expiry, or schema failure;
- incompatible platform, architecture, libc, Node ABI, Node major, or package-manager runtime;
- disk-space or resource-limit failure;
- archive hash, size, format, or extraction-policy failure;
- dependency sandbox, dependency installation, cache mutation, prepared-tree, or migration failure;
- activation, PM2, readiness, restart-loop, or rollback failure.

Logs never contain keys beyond public key IDs, environment secrets, Telegram tokens, chat IDs, or response bodies. Public manifest versions, commits, artifact digests, state phases, and failure codes are safe to log.

Network errors are quiet during scheduled polling while trusted metadata remains unexpired. Expired-metadata network failure and security/integrity failures notify administrators once per distinct failure identity per day. Manual commands always return a concise typed reason.

## 17. Testing

### Unit tests

- valid Ed25519 signatures and rejection after changing any payload byte;
- wrong, malformed, duplicate, unknown, and non-Ed25519 keys;
- strict Base64 versus Node's permissive decoding behavior;
- invalid UTF-8, BOM, duplicate JSON keys, unknown keys, and every manifest bound;
- metadata version monotonicity, same-version equivocation, expiry, clock skew, and metadata-only refresh;
- effective-time floor, boot-ID change, clock rollback, and conditional cross-reboot time behavior;
- SemVer current, upgrade, prerelease, and downgrade decisions;
- metadata identity versus artifact identity and target-specific version immutability;
- URL normalization, credentials, fragments, ports, redirects, and origin restrictions;
- streaming hashes, exact byte counts, timeouts, cancellation, and size ceilings;
- trusted-state size/ledger bounds, operation-journal atomic persistence, and corrupt-state recovery;
- artifact identity resolution from symlink plus `artifact-state.json`;
- stable-channel prerelease rejection and same-version artifact immutability.

### Archive and dependency tests

- absolute paths, `..`, links, devices, FIFOs, sparse/PAX entries, duplicate paths, control characters, permissions, and ownership;
- compressed and expanded bombs, too many entries, long paths, large files, truncation, and trailing archive data;
- nested Yarn cache ZIP bombs, encryption, duplicate/traversing paths, malformed metadata, and aggregate inner size/file-count ceilings;
- private temporary-directory and exclusive-file behavior under hostile pre-existing paths;
- clean target-specific production cache generation for every supported Pi target;
- complete Yarn install with Yarn networking disabled and operating-system network isolation proven by a lifecycle script that attempts external access;
- lifecycle-script attempts to read `.env`, the shared database, PM2 state, logs, and media fail before persistent links exist;
- user/global Yarn configuration and hostile `YARN_*` or npm environment overrides cannot change the fixed preparation policy;
- package, lockfile, Yarn configuration, runtime, and cache immutability around `workspaces focus`;
- missing or modified Yarn runtime/cache entry and native build failure;
- prepared-size/file ceilings, low-space/inode abort, emergency-reserve release, cleanup, and reserve recreation;
- deterministic prepared-tree digest and detection of modified files, modes, types, or links;
- secret and runtime-state denylist enforcement in the publisher;
- independent-builder mismatch, forged or missing verification attestation, and serialized metadata-version allocation.

### Integration and recovery tests

- `200`, valid `304`, invalid cached `304`, timeout, partial body, transformation, cross-origin redirect, and publication expiry;
- check/apply feed change aborting instead of installing a substituted release;
- concurrent scheduled checks, simultaneous `/update` calls, update versus rollback, process kill, and reboot without stale locks;
- updater death while the preparation unit remains active, preparation-lease blocking, full-cgroup termination, and journal reconciliation before a replacement update;
- disk-full conditions before download, during extraction, dependency installation, journal writes, and symlink activation;
- process kill and storage-level power loss after every operation phase, including after the candidate durability barrier and before the `prepared` journal write;
- recovery before PM2 when the selected application cannot start;
- hostile journal paths proving unprivileged recovery cannot address `shared/` or escape `releases/`;
- operation schema compatibility and rejection of unsupported phases or schema versions before filesystem mutation;
- one-time migration success, rollback, permissions, and absent initial `previous` target;
- failed migration, PM2 start, readiness identity, restart-loop, and stable-uptime checks restoring the prior release;
- pre-activation failure delivery by the live monitor, post-stop delivery by the boot reporter, crash between result persistence and delivery, and idempotent acknowledgement without filesystem chat IDs;
- successful install and rollback without Git credentials or a `.git` directory;
- rollback identity allowing the rolled-back version to be reinstalled later;
- metadata refresh reusing the same artifact directory without duplicate update notifications;
- a reused artifact's historical known-good marker cannot satisfy health for a new interrupted activation;
- `healthy` boot recovery defers the `system_meta` mirror and terminal notification to successful worker startup;
- 32-bit and 64-bit target mismatch rejection before download;
- key overlap, new-key adoption, active-to-retired transition, recovery of an old known-good artifact, rejection of retired-key feed authorization, safe retired-key removal, and untrusted key substitution.

## 18. Acceptance criteria

The feature is complete when:

- a clean Pi discovers and notifies once about a public signed release without credentials;
- an existing in-place installation moves to the versioned layout only through the authenticated maintenance migration;
- `/update` installs only the exact displayed identity;
- no unsigned, expired, replayed, equivocated, transformed, oversized, or unsafe release reaches activation;
- all executable application, dependency, and package-manager inputs originate in the verified archive, and native outputs are derived from those inputs inside the network-isolated preparation unit;
- a compromised general builder cannot obtain a signature for bytes that fail independent reproduction from the operator-approved commit;
- activation is atomic and boot recovery produces either the old or new complete release, never a mixed tree;
- rollback works without Git, updates active release identity, and remains reversible;
- concurrent commands and crashes cannot leave a stale update lock;
- a compromised website without a signing key can cause temporary unavailability but cannot install code;
- current and previous known-good releases survive until the new release and all metadata are durable;
- metadata refreshes and reinstalling a rolled-back release reuse immutable artifact-addressed directories;
- dependency lifecycle execution has no IP network access and cannot modify the signed cache or project inputs;
- tests cover the enumerated security, resource, concurrency, and power-loss cases.

## 19. Non-goals

- Keeping release contents private.
- Fully automatic installation after polling.
- Updating Node.js major versions or operating-system packages.
- Differential, resumable, or peer-to-peer updates.
- Multiple release channels beyond configured `stable`.
- Full TUF role delegation, threshold policy, or automatic compromised-root recovery.
- Protecting a Pi after its local service account or operating system is compromised.
- Providing unconditional cross-reboot expiry on Pi hardware without a trusted RTC or external authenticated time source.
- Reversing committed database migrations during application rollback.

## 20. Reference rationale

- The Update Framework client workflow motivates bounded metadata, monotonic versions, persisted trusted state, expiry, freeze detection, and consistent target identity: <https://theupdateframework.github.io/specification/draft/>.
- RFC 9111 defines `no-cache`, validators, `304`, `must-revalidate`, and `no-transform`: <https://datatracker.ietf.org/doc/html/rfc9111>.
- Node 20 requires a key-dependent `null` algorithm for Ed25519 verification and supports SPKI public keys: <https://nodejs.org/docs/latest-v20.x/api/crypto.html>.
- Node Base64 decoding is intentionally permissive, which is why the envelope requires strict canonical validation: <https://nodejs.org/docs/latest-v20.x/api/buffer.html>.
- Yarn's cache/configuration behavior and production workspace focus inform the signed offline dependency closure: <https://yarnpkg.com/configuration/yarnrc>, <https://yarnpkg.com/cli/workspaces/focus>.
- Archive extraction guidance motivates type, path, permission, count, and expanded-size limits: <https://docs.python.org/3/library/tarfile.html#extraction-filters>.
