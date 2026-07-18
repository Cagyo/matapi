# Public Signed OTA Release Feed

> **Date:** 2026-07-18
> **Status:** approved design
> **Scope:** replace Git-based production update discovery and unsigned release downloads with a public, signed HTTP release feed for Raspberry Pi workers

## 1. Goal

Each Raspberry Pi checks a public website for a newer application release without holding GitHub credentials or update-site credentials. The Pi installs a release only when it can prove that the release was signed by the trusted publisher and that the downloaded archive matches the signed metadata.

Authentication is intentionally absent because the release payload is treated as public. Authenticity comes from an Ed25519 signature whose private key is never stored on the website or a Pi.

## 2. Security model

The design protects against:

- a compromised update website or CDN replacing the manifest or archive;
- network interception despite HTTPS failure or misconfiguration;
- a truncated or corrupted archive;
- replay of an older, valid release as an automatic update;
- a compromised Pi gaining permission to publish releases.

The design does not hide the application. JavaScript in `dist/`, migrations, package metadata, and operational scripts must be considered public. Release archives must never contain `.env*`, tokens, databases, logs, device configuration, private keys, or other runtime state.

The signing private key is the root of trust. It is held by the trusted release publisher, outside the web root and outside the application repository. The Pi receives only the public key. If the private key is compromised, it must be replaced manually on each Pi; automated remote trust-root rotation is outside this design.

## 3. Published files

The update origin exposes three unauthenticated HTTPS resources:

```text
/home-worker/stable/manifest.json
/home-worker/stable/manifest.json.sig
/home-worker/releases/home-worker-1.4.2.tar.gz
```

Artifacts are immutable and versioned. The stable manifest and detached signature are the only mutable resources.

The server sends `Cache-Control: no-cache` and an `ETag` for the manifest and signature. Versioned archives use a long immutable cache policy. Publishing uploads the archive first, then publishes the signed manifest and signature last, so a visible manifest never intentionally points to an absent archive.

## 4. Manifest contract

The publisher serializes `manifest.json` as UTF-8 and signs its exact raw bytes. The Pi verifies the detached signature before parsing or trusting any field, avoiding JSON canonicalization ambiguity.

```json
{
  "schemaVersion": 1,
  "channel": "stable",
  "version": "1.4.2",
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "publishedAt": "2026-07-18T12:00:00Z",
  "artifact": {
    "url": "https://updates.example.com/home-worker/releases/home-worker-1.4.2.tar.gz",
    "size": 18432000,
    "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  },
  "runtime": {
    "nodeMajor": 20
  }
}
```

Rules:

- `schemaVersion` must equal `1`; unknown versions fail closed.
- `channel` must match the configured channel.
- `version` is a valid SemVer release without build metadata.
- `commit` is a full 40-character Git commit identifier used for traceability only.
- `publishedAt` is an RFC 3339 UTC timestamp.
- `artifact.url` must use HTTPS and match the configured update origin.
- `artifact.size` is a positive integer and cannot exceed the configured download limit.
- `artifact.sha256` is exactly 64 lowercase hexadecimal characters.
- `runtime.nodeMajor` must match the installed Node major version; major upgrades remain manual.

The detached signature file contains the Base64-encoded Ed25519 signature of the raw manifest bytes followed by one newline. Verification removes only that newline, requires canonical Base64, and requires the decoded Ed25519 signature to be exactly 64 bytes.

## 5. Device trust and configuration

The public key is provisioned during installation as a root-owned file outside the application directory:

```text
/etc/home-worker/update-public-key.pem
```

Recommended ownership and permissions are `root:root` and `0644`. Application updates cannot replace this file.

Configuration:

```text
HOME_WORKER_UPDATE_MANIFEST_URL=https://updates.example.com/home-worker/stable/manifest.json
HOME_WORKER_UPDATE_PUBLIC_KEY_PATH=/etc/home-worker/update-public-key.pem
HOME_WORKER_UPDATE_CHANNEL=stable
HOME_WORKER_UPDATE_POLL_MINUTES=60
HOME_WORKER_UPDATE_MAX_BYTES=104857600
```

The default poll interval is 60 minutes with up to five minutes of random startup jitter. The Telegram `/update` action performs an immediate check. Automatic checks do not overlap; a check already in progress causes the next scheduled invocation to be skipped.

After successful verification, the raw manifest, detached signature, and response `ETag` are persisted atomically as an untrusted cache. A conditional request sends `If-None-Match` only when that complete cache exists. On `304 Not Modified`, the Pi verifies the cached raw manifest and signature again before using them; otherwise it retries once without the conditional header.

## 6. Architecture

The existing `system` bounded context remains responsible for OTA behavior.

- The application-facing `OtaPort` keeps the existing check, start-update, and rollback responsibilities, but `UpdateCheck` reports release versions and commits rather than local and remote Git refs.
- A signed HTTP release-feed adapter fetches the manifest and signature, verifies Ed25519 over the raw manifest bytes, validates the manifest schema, and compares its version to the installed version.
- A detached updater re-fetches and re-verifies the manifest when applying an update. A prior successful check is never treated as authorization because the manifest may change between check and apply.
- The updater streams the archive to a temporary file while enforcing the declared size and configured maximum, then checks the exact byte count and SHA-256 digest.
- The existing snapshot, dependency installation, migration, PM2 restart, health check, notification, and rollback behavior remains in place.

The installed release identity is stored in `system_meta` as `installed_release_version` and `installed_release_commit` after a successful health check. Before the first feed-based update, the version falls back to the root `package.json` value; an absent or invalid fallback version is a typed configuration failure rather than permission to install an arbitrary version.

Production updates no longer fall back to `git fetch` or require a `.git` directory. The local development update path remains separate and unchanged.

Signature verification uses Node 20's built-in `node:crypto` Ed25519 support so the Pi does not need GPG, Minisign, or another runtime verification package.

## 7. Update flow

### Check

1. Fetch raw `manifest.json` with connect, response, and total-request timeouts. Follow at most three redirects, and only when every target has the same HTTPS origin (scheme, hostname, and effective port) as the configured manifest URL.
2. On `304`, re-verify and use the complete cached response; retry unconditionally if the cache is absent or invalid.
3. Fetch the detached signature from the same path plus `.sig`.
4. Verify the signature against the provisioned public key.
5. Parse and validate the manifest.
6. Compare the signed SemVer version to the installed version.
7. Report `available`, `current`, or a typed failure to the existing Telegram flow.

### Apply

1. Acquire the existing single-update lock.
2. Re-fetch and re-verify the manifest and signature.
3. Reject a version equal to or lower than the installed version. Downgrades are permitted only through the explicit local rollback command.
4. Create the existing rollback snapshot.
5. Stream the archive to a fresh staging location while hashing and enforcing size limits.
6. Require the downloaded byte count and SHA-256 to match the signed manifest.
7. Inspect archive entries before extraction; reject absolute paths, `..` traversal, symbolic links, hard links, and device files.
8. Extract and synchronize the staged release without touching `data/`, `.env*`, or the external public key.
9. Install production dependencies, run backward-compatible migrations, restart through PM2, and perform the existing health check.
10. Record the installed version and commit only after the health check succeeds.
11. On failure after snapshot creation, restore the previous release and report the typed failure.

## 8. Failure behavior

Routine network failures leave the current release running and are logged without repeated Telegram noise. Manual `/update` checks return the reason to the administrator.

An invalid signature, invalid manifest, checksum mismatch, archive-size mismatch, unsafe archive entry, or attempted automatic downgrade fails closed before installation. These failures produce an administrator alert because they may indicate publishing error or tampering.

If dependency installation, migration, restart, or health checking fails, the existing rollback flow restores the previous application files. Database migrations remain forward-only, so all OTA migrations must continue to be backward-compatible with the immediately previous release.

The updater never deletes the last known-good rollback snapshot until a new release passes its health check.

## 9. Release publishing

The publisher performs these steps on a trusted release workstation or CI runner:

1. Build and test the exact tagged revision.
2. Assemble a deterministic release archive containing the prebuilt `dist/`, required scripts, migrations, production package metadata, and dependency lock data.
3. Scan the archive contents against the secret and runtime-state denylist.
4. Compute the archive byte size and SHA-256 digest.
5. Generate the manifest from the release version, commit, runtime requirement, immutable URL, size, and digest.
6. Sign the exact manifest bytes with the Ed25519 private key.
7. Upload the archive under its immutable versioned name.
8. Upload the manifest and detached signature last using an atomic replace where the host supports it.

The website receives only public artifacts. Upload credentials and the signing private key are separate credentials; compromising upload access alone cannot produce a trusted release.

## 10. Testing and acceptance criteria

Unit tests cover:

- valid signatures and rejection after changing any manifest byte;
- malformed signature encoding and wrong public keys;
- every manifest validation rule;
- SemVer upgrade, equal-version, and downgrade decisions;
- origin restriction and Node-major compatibility;
- streaming digest and size enforcement.

Integration and script tests cover:

- `200`, `304`, timeout, truncated response, and redirect behavior from a local HTTP server;
- valid update installation without any Git credentials or `.git` directory;
- invalid signature, incorrect SHA-256, incorrect size, oversized archive, and unsafe tar entries;
- publication race where the signed manifest is visible before its artifact;
- failed dependency install, migration, restart, and health check restoring the prior release;
- successful update persisting the signed version and commit;
- `/update` reporting current, available, and typed failure outcomes.

The feature is complete when a clean Pi installation can discover, verify, install, health-check, and roll back public site-hosted releases with no GitHub or update-site credentials, and no unsigned or replayed release can reach the installation step.

## 11. Non-goals

- Keeping release contents private.
- Updating Node.js major versions or operating-system packages.
- Differential or peer-to-peer updates.
- Multiple release channels beyond the configured `stable` value.
- Automatic signing-key rotation or revocation infrastructure.
- Replacing the existing PM2 health-check and rollback mechanism.
