# Public Signed OTA Release Feed

> **Date:** 2026-07-18
> **Status:** revised after adversarial review; awaiting final approval
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
- replay of older signed metadata, silent update freezing beyond a bounded expiry window, and automatic downgrade attempts;
- truncated, transformed, oversized, or corrupted downloads;
- archive traversal, unsafe entry types, duplicate paths, and decompression resource exhaustion;
- interruption or power loss during download, installation, activation, or health checking;
- a compromised Pi gaining permission to publish releases.

The design does not hide the application. JavaScript in `dist/`, migrations, package metadata, dependency archives, and operational scripts must be treated as public. Release archives must never contain `.env*`, tokens, databases, logs, device configuration, private keys, captured media, or other runtime state.

The signing private key is the root of trust. A signing-key compromise permits malicious releases until the compromised public key is manually revoked on each Pi. Automated remote root-key recovery and threshold signing are outside this design; basic overlapping-key rotation is supported as described below.

A fully compromised Pi can modify its own files and execution. Local-host compromise resistance is not a goal. The design limits that compromise to the device and prevents it from becoming release-publishing authority.

## 3. Trust bootstrap and key lifecycle

The update website is never trusted to bootstrap its own verification key.

The installer receives at least one Ed25519 public key through one of these authenticated paths:

1. the key is embedded in an installer bundle whose SHA-256 fingerprint the operator verifies out of band; or
2. the operator copies the key to the Pi over an already authenticated administrative channel and verifies its fingerprint.

The installer writes trusted keys beneath:

```text
/etc/home-worker/update-keys/<key-id>.pem
```

The directory and keys are owned by `root:root`; the directory is `0755` and key files are `0644`. The `homeworker` service account can read but cannot replace them. `key-id` is the lowercase SHA-256 digest of the DER-encoded SPKI public key.

The verifier parses each configured key with `createPublicKey`, requires `asymmetricKeyType === 'ed25519'`, and ignores malformed, unknown, duplicate, or non-Ed25519 keys. Verification succeeds only when at least one signature from a currently trusted key is valid.

Manual rotation uses an overlap:

1. provision the new public key on every Pi through the authenticated administrative path;
2. publish envelopes signed by both old and new keys;
3. verify fleet acceptance of the new key;
4. remove the old key from each Pi;
5. stop producing the old signature.

The private key is never stored in the repository, website, general build job, or Pi. For a single-operator deployment, the recommended publisher is an encrypted offline signing key. If CI signing is used, a protected signing job requires human approval, does not check out or execute repository code, recomputes the artifact hash itself, and uses a non-exportable signing key where available.

## 4. On-device release layout

Application code is immutable after release preparation:

```text
/opt/home-worker/
  current -> releases/42-1.4.2-2a1c4e09c12b/
  previous -> releases/41-1.4.1-708ed2e991ef/
  releases/
    41-1.4.1-708ed2e991ef/
    42-1.4.2-2a1c4e09c12b/
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

`/usr/local/lib/home-worker/ota-recover.mjs` is a minimal installer-owned recovery launcher outside the service-writable application tree. It is root-owned, is not replaced by application OTA, and is invoked by the system service before PM2 resurrection. It reconciles the dual-slot operation journal and symlinks even when the selected application release cannot start. Normal updates to this launcher require an authenticated maintenance installation, not an application release.

Activation creates a temporary symlink in `/opt/home-worker`, calls `fsync` on required files and directories, and renames the temporary link over `current` on the same filesystem. The operation journal records the prior `current` and `previous` targets before activation. `previous` is updated to the prior `current` target only after the candidate passes health checking. The old release is retained throughout.

Each prepared release contains `release-state.json` and `release-envelope.json`, written by the updater rather than read from the archive. They record the verified envelope, its digest, metadata version, application version, commit, artifact hash, and preparation time. After health succeeds, the updater adds `known-good.json` with the same release identity and health timestamp. The active symlink target plus these files is the source of truth for the installed release. `system_meta` mirrors that identity for Telegram reporting but is not authoritative.

## 5. Published resources

The update origin exposes two unauthenticated HTTPS resources:

```text
/home-worker/stable/update-envelope.json
/home-worker/releases/home-worker-1.4.2.tar.gz
```

Artifacts are immutable and versioned. Reusing an artifact URL for different bytes is a publishing failure.

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
  "artifact": {
    "url": "https://updates.example.com/home-worker/releases/home-worker-1.4.2.tar.gz",
    "format": "tar.gz",
    "size": 52428800,
    "expandedSize": 209715200,
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
- `channel` exactly matches the configured ASCII channel;
- `version` is a bounded SemVer release without build metadata;
- the `stable` channel rejects prerelease SemVer versions;
- `commit` is exactly 40 lowercase hexadecimal characters and is traceability data only;
- timestamps are strict RFC 3339 UTC values, `publishedAt < expiresAt`, and validity is no longer than 31 days;
- `publishedAt` cannot exceed the fixed check-start time by more than five minutes;
- `expiresAt` must be later than the fixed check-start time;
- `artifact.url` contains no credentials or fragment, uses HTTPS, and has the same normalized origin as the configured feed URL;
- `artifact.format` equals `tar.gz`;
- sizes and counts are positive safe integers within configured hard limits;
- `artifact.sha256` is exactly 64 lowercase hexadecimal characters;
- `runtime.nodeMajor` equals the installed Node major version;
- `runtime.packageManager` equals the signed Yarn runtime bundled in the archive.

Trusted state also enforces release immutability: once an application version has been observed, a later metadata refresh using that same version must retain the same artifact URL, format, sizes, file count, and digest. Changed bytes require a new application version.

The publisher may refresh metadata without changing the application release. A refresh increments `metadataVersion`, advances `publishedAt` and `expiresAt`, and retains the same application version and artifact identity. Publication monitoring must refresh the envelope before expiry.

Metadata expiry requires a trustworthy clock. The existing clock-sync port must report synchronized time before a new envelope becomes trusted or an update starts. An unsynchronized clock leaves the current release running, fails closed for installation, and reports a clock-specific diagnostic.

## 7. Parser, transport, and resource bounds

Configuration:

```text
HOME_WORKER_UPDATE_FEED_URL=https://updates.example.com/home-worker/stable/update-envelope.json
HOME_WORKER_UPDATE_TRUST_DIR=/etc/home-worker/update-keys
HOME_WORKER_UPDATE_CHANNEL=stable
HOME_WORKER_UPDATE_POLL_MINUTES=60
HOME_WORKER_UPDATE_MAX_ARTIFACT_BYTES=104857600
HOME_WORKER_UPDATE_MAX_EXPANDED_BYTES=536870912
HOME_WORKER_UPDATE_MAX_FILES=20000
HOME_WORKER_UPDATE_HEALTH_SECONDS=60
```

The feed URL and trust directory are required in production. Other values default as shown and are parsed as bounded positive integers during startup; malformed values are configuration failures rather than permissive fallbacks.

Defaults are configurable downward but cannot be raised beyond compiled hard ceilings:

```text
envelope response       96 KiB
decoded manifest        64 KiB
signature count          3
decoded signature       64 bytes
compressed artifact    100 MiB
expanded archive       512 MiB
archive entries         20,000
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

Before downloading, the updater verifies that the destination filesystem has space for the compressed artifact, declared expansion, a candidate dependency installation, the current and previous releases, and fixed safety headroom. Disk pressure fails before the running service is stopped.

## 8. Architecture and boundaries

The existing `system` bounded context remains responsible for OTA behavior.

The application layer uses these concepts:

- `ReleaseIdentity`: metadata version, application version, commit, envelope digest, and artifact hash;
- `UpdateCheck`: `current`, `available`, or typed failure, including the exact available `ReleaseIdentity`;
- `OtaPort.checkForUpdates()`: verifies and persists trusted metadata without modifying the live release;
- `OtaPort.startUpdate(expected: ReleaseIdentity)`: starts only the exact checked identity and returns after an atomic updater lock/operation receipt is established;
- `OtaPort.startRollback()`: activates the local previous known-good release without consulting Git or the remote feed;
- a signed HTTP release-feed adapter for transport, envelope verification, strict parsing, expiry, and trusted-state persistence;
- a detached updater for artifact verification, candidate preparation, activation, health checking, and recovery.

The installer-owned recovery launcher is deliberately smaller than the application updater. It performs no network access, metadata advancement, extraction, dependency installation, migration, or health checking. It validates the durable operation journal and local release identities, reverses any activation that was not durably marked healthy, and finalizes already-healthy state before PM2 starts.

Check scheduling uses process-local single-flight protection. Apply and rollback share a kernel-owned `flock` lock at `/run/home-worker/ota.lock`; systemd creates `/run/home-worker` for the service account. The kernel releases the lock when the owning process exits, so crashes do not leave a permanent stale lock. The check-then-spawn lockfile pattern is removed.

The updater is executed from the current immutable release. Versioned activation never overwrites that release while the updater is running. `startUpdate` passes the expected identity and waits for an explicit child handshake confirming that the updater acquired the lock and durably created its operation receipt before reporting “started.”

## 9. Trusted state

Trusted state uses alternating `trusted-state-a.json` and `trusted-state-b.json` slots with monotonically increasing local generations. Each slot is written with a temporary file, file `fsync`, atomic rename, and parent-directory `fsync`; the older valid slot is retained until the newer slot is durable. A slot contains:

- highest verified `metadataVersion` and its payload digest;
- the last verified envelope bytes and their strong `ETag`;
- the last notified application version;
- failure-notification rate-limit state.

State is untrusted input on read and is schema-validated. Signed envelope verification remains authoritative. Recovery selects the highest valid local generation and cross-checks its payload digest against the stored signed envelope. If both state slots are missing or corrupt, the updater enters a `trust-state-lost` failure and requires authenticated operator recovery. Current and previous release envelopes can prove installed identities but cannot reconstruct the highest metadata version ever observed, so an unconditional feed response is never allowed to reset the anti-rollback floor.

On `304 Not Modified`, the Pi re-verifies the envelope stored in the selected state slot, validates it against the persisted highest metadata version, and checks expiry. If the envelope is absent, corrupt, unverifiable, or expired, the Pi retries once without `If-None-Match`. A still-expired envelope is reported as a potential freeze or publishing failure.

The fixed update-check time is captured once after clock synchronization and reused for all expiry checks in that check cycle.

## 10. Discovery and notification flow

Automatic checks run every 60 minutes with up to five minutes of startup jitter. They never overlap and never install an update.

1. Confirm synchronized system time.
2. Fetch the envelope conditionally when a complete cache exists.
3. Enforce response bounds and transport policy.
4. Strictly parse the outer envelope and decoded payload.
5. Load trusted Ed25519 public keys and verify at least one recognized signature.
6. Validate manifest schema, origin, runtime compatibility, metadata monotonicity, and expiry.
7. Atomically persist the new trusted metadata state.
8. Resolve the installed identity from the `current` release directory.
9. If the signed application version is newer, notify administrators once for that version.
10. If the version is current, report current without notification, even when metadata was refreshed.

Routine network failures retain the current release and are logged without Telegram noise while the last trusted metadata remains unexpired. Once cached trusted metadata expires, continuing network failure becomes an administrator-visible freeze-or-unavailability condition, rate-limited by distinct failure identity and day. Signature, equivocation, rollback, expiry, or trust-root failures are also administrator-visible under the same rate limit.

The manual `/update` command performs the same check, displays the exact application version and short commit, and calls `startUpdate` with that `ReleaseIdentity`. If the cached envelope no longer matches that identity, the updater aborts and asks the administrator to check again; it never silently substitutes a newer release.

## 11. Apply and activation flow

1. Atomically acquire the kernel update lock and durably create the first operation-journal slot with the expected identity, prior `current` and `previous` targets, candidate target, and phase `preparing`.
2. Load the envelope from the selected trusted-state slot, then re-verify its signature, expiry, metadata monotonicity, and exact expected identity.
3. Preflight filesystem space and runtime compatibility.
4. Download the immutable archive into the private temporary directory while streaming its SHA-256 and enforcing exact compressed size.
5. Require the actual digest and byte count to equal the signed values.
6. Inspect the archive structurally and enforce all extraction rules and expanded-resource limits.
7. Extract into a new release directory on the same filesystem as `current`.
8. Create installer-owned links to persistent runtime paths.
9. Verify the bundled Yarn runtime and offline cache are present, then install production dependencies inside the candidate using offline, immutable settings and Pi job/memory limits.
10. Write and `fsync` `release-state.json` and `release-envelope.json`; mark the operation phase `prepared`.
11. Stop the existing PM2 worker so migrations do not race the old process.
12. Run the candidate's forward-compatible migrations. Migration failure must be transactional or safely retryable.
13. Mark the operation `activating`, atomically switch `current`, and then durably mark the operation `activated` before starting the candidate.
14. Remove any old readiness marker and start PM2 against `current`.
15. Require a readiness marker from the new PID containing the expected envelope digest and version, PM2 `online`, no restart-count increase, and stable uptime for 60 seconds.
16. Write and `fsync` candidate `known-good.json`, mark the operation `healthy`, update `previous` to the recorded prior `current`, mirror installed identity to `system_meta`, retain both known-good releases, and prune older releases only after all state is durable.
17. Notify administrators of success through the existing restart-confirmation path.

The readiness marker is `/run/home-worker/ready.json`, written atomically by the worker after configuration loading, database access, migrations, and required local module initialization succeed. External Telegram, cloud, or internet availability is not part of local release health.

The signed release archive includes:

- prebuilt `dist/`;
- migrations and required operational scripts;
- `package.json`, the dependency lockfile, and required workspace metadata;
- the exact Yarn 4.13 runtime under `.yarn/releases/`;
- a complete production dependency cache under `.yarn/cache/`.

The on-device Yarn configuration enables offline mode, immutable installs, and immutable cache. Native dependency lifecycle builds still run on the Pi with `jobs=1` and the existing memory cap, but all executed package content originates inside the verified archive. CI runs Yarn cache/checksum validation before signing.

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
2. resolves and validates `previous` and its `release-state.json`;
3. records a rollback operation with both symlink targets;
4. stops PM2, atomically switches `current` to the previous release, and starts it;
5. applies the same readiness and stable-uptime health check;
6. mirrors the now-active release identity to `system_meta` after success;
7. restores the original `current` target if rollback health checking fails.

Repeated rollback does not keep selecting the same directory accidentally: after a successful rollback, `previous` is updated to the release that was active before rollback, making the operation reversible.

The operation journal uses alternating `operation-a.json` and `operation-b.json` slots with monotonically increasing local generations and the same file/directory `fsync` discipline as trusted state. At boot, the recovery launcher selects the highest valid generation:

- `preparing` or `prepared` with unchanged `current` removes the incomplete candidate and preserves the current release;
- `activating` or `activated` finalizes the candidate only when a matching durable `known-good.json` exists; otherwise it atomically restores the recorded prior `current` and `previous` targets before PM2 starts;
- `healthy` finalizes mirrored metadata and deferred pruning idempotently;
- if both operation slots are corrupt, recovery selects `current` only when it has a valid known-good marker; otherwise it selects a valid known-good `previous`; if neither exists, it leaves PM2 stopped and requires authenticated maintenance.

The installer-owned recovery launcher runs these checks before PM2 resurrection, so recovery does not depend on either application release reaching Nest bootstrap. It validates local release identity against the stored signed envelope but does not apply remote expiry rules to an already installed known-good release.

Power loss is tested after every durable phase transition. Temporary paths, candidate releases, and symlinks are never selected solely by modification time.

Database migrations remain forward-only and must be backward-compatible with the immediately previous release because code rollback does not reverse a successfully committed database migration.

## 14. Initial migration to the release layout

The existing in-place `/opt/home-worker` installation cannot safely convert itself to the new trust root and directory layout through the legacy unsigned updater.

Adoption is a one-time authenticated maintenance operation:

1. stop PM2;
2. back up the current application and database using the existing operational backup procedure;
3. provision and verify the initial update public key out of band;
4. install the root-owned recovery launcher and system-service pre-start hook;
5. create `shared/`, move existing runtime state into it, and validate ownership and permissions;
6. install a verified baseline release under `releases/`, write its local release identity files, and seed both trusted-state slots from its signed envelope;
7. create `current`, omit `previous` until a second known-good release exists, and point PM2 at `current`;
8. start the worker, require the full readiness check, write the baseline known-good marker, and retain the pre-migration backup until the first feed update succeeds.

If any step fails, the maintenance installer restores the pre-migration layout and does not enable feed polling. Subsequent application updates use only the signed feed workflow.

## 15. Release publishing

Publishing is split into an untrusted build stage and a protected signing stage.

### Build stage

1. Build and test the exact tagged revision.
2. Require the tag, `package.json` version, and requested release version to match.
3. Populate and validate the complete Yarn offline cache and pinned Yarn runtime.
4. Assemble a deterministic archive with sorted paths, normalized ownership, timestamps, and permissions.
5. Reject secrets, runtime state, links, special files, unexpected top-level paths, and files outside the release allowlist.
6. Compute compressed size, expanded regular-file bytes, file count, and SHA-256.
7. Produce the unsigned manifest input and immutable build outputs.

### Protected signing and publication stage

1. Require explicit release approval.
2. Do not check out or execute repository code or archive contents.
3. Recompute archive hash, sizes, and structural policy independently.
4. Generate a fresh monotonic metadata version and an expiry no more than 31 days away.
5. Sign the exact manifest bytes with each active protected Ed25519 key.
6. Upload the immutable archive first and refuse to overwrite an existing URL.
7. Fetch the public archive independently and verify its size and hash.
8. Atomically replace the single update envelope last.
9. Fetch and verify the public envelope and artifact relationship through the CDN path.
10. Monitor envelope expiry and refresh signed metadata before it expires, even when no application release changes.

Website upload credentials and signing authority remain separate. Compromising the website or upload account alone cannot produce a trusted release.

## 16. Failure behavior and observability

Before activation, every failure leaves the current process and symlink unchanged. After activation, failure restores the recorded prior target and restarts it.

Typed failures distinguish:

- clock unsynchronized;
- network unavailable, timeout, redirect, or HTTP status failure;
- envelope too large or malformed;
- trust key missing or invalid;
- signature invalid;
- metadata rollback, equivocation, freeze/expiry, or schema failure;
- incompatible Node or package-manager runtime;
- disk-space or resource-limit failure;
- archive hash, size, format, or extraction-policy failure;
- dependency installation or migration failure;
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
- SemVer current, upgrade, prerelease, and downgrade decisions;
- URL normalization, credentials, fragments, ports, redirects, and origin restrictions;
- streaming hashes, exact byte counts, timeouts, cancellation, and size ceilings;
- trusted-state and operation-journal atomic persistence and corrupt-state recovery;
- release identity resolution from symlink plus `release-state.json`;
- stable-channel prerelease rejection and same-version artifact immutability.

### Archive and dependency tests

- absolute paths, `..`, links, devices, FIFOs, sparse/PAX entries, duplicate paths, control characters, permissions, and ownership;
- compressed and expanded bombs, too many entries, long paths, large files, truncation, and trailing archive data;
- private temporary-directory and exclusive-file behavior under hostile pre-existing paths;
- complete offline Yarn install with network disabled;
- missing or modified Yarn runtime/cache entry and native build failure;
- secret and runtime-state denylist enforcement in the publisher.

### Integration and recovery tests

- `200`, valid `304`, invalid cached `304`, timeout, partial body, transformation, cross-origin redirect, and publication expiry;
- check/apply feed change aborting instead of installing a substituted release;
- concurrent scheduled checks, simultaneous `/update` calls, update versus rollback, process kill, and reboot without stale locks;
- disk-full conditions before download, during extraction, dependency installation, journal writes, and symlink activation;
- power loss after every operation phase and recovery on boot;
- recovery before PM2 when the selected application cannot start;
- one-time migration success, rollback, permissions, and absent initial `previous` target;
- failed migration, PM2 start, readiness identity, restart-loop, and stable-uptime checks restoring the prior release;
- successful install and rollback without Git credentials or a `.git` directory;
- rollback identity allowing the rolled-back version to be reinstalled later;
- metadata refresh without duplicate update notifications;
- key overlap, new-key adoption, old-key removal, and untrusted key substitution.

## 18. Acceptance criteria

The feature is complete when:

- a clean Pi discovers and notifies once about a public signed release without credentials;
- an existing in-place installation moves to the versioned layout only through the authenticated maintenance migration;
- `/update` installs only the exact displayed identity;
- no unsigned, expired, replayed, equivocated, transformed, oversized, or unsafe release reaches activation;
- all executable application, dependency, and package-manager bytes originate in the verified archive;
- activation is atomic and boot recovery produces either the old or new complete release, never a mixed tree;
- rollback works without Git, updates active release identity, and remains reversible;
- concurrent commands and crashes cannot leave a stale update lock;
- a compromised website without a signing key can cause temporary unavailability but cannot install code;
- current and previous known-good releases survive until the new release and all metadata are durable;
- tests cover the enumerated security, resource, concurrency, and power-loss cases.

## 19. Non-goals

- Keeping release contents private.
- Fully automatic installation after polling.
- Updating Node.js major versions or operating-system packages.
- Differential, resumable, or peer-to-peer updates.
- Multiple release channels beyond configured `stable`.
- Full TUF role delegation, threshold policy, or automatic compromised-root recovery.
- Protecting a Pi after its local service account or operating system is compromised.
- Reversing committed database migrations during application rollback.

## 20. Reference rationale

- The Update Framework client workflow motivates bounded metadata, monotonic versions, persisted trusted state, expiry, freeze detection, and consistent target identity: <https://theupdateframework.github.io/specification/draft/>.
- RFC 9111 defines `no-cache`, validators, `304`, `must-revalidate`, and `no-transform`: <https://datatracker.ietf.org/doc/html/rfc9111>.
- Node 20 requires a key-dependent `null` algorithm for Ed25519 verification and supports SPKI public keys: <https://nodejs.org/docs/latest-v20.x/api/crypto.html>.
- Node Base64 decoding is intentionally permissive, which is why the envelope requires strict canonical validation: <https://nodejs.org/docs/latest-v20.x/api/buffer.html>.
- Yarn's immutable install/cache behavior informs the signed offline dependency closure: <https://yarnpkg.com/cli/install>.
- Archive extraction guidance motivates type, path, permission, count, and expanded-size limits: <https://docs.python.org/3/library/tarfile.html#extraction-filters>.
