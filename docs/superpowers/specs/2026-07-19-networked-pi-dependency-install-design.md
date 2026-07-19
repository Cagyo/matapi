# Pi-side production dependency installation

## Decision

Release archives contain compiled application assets and locked install metadata,
but never `node_modules` or `.yarn/cache`. A Raspberry Pi installs production
dependencies from the public npm registry during candidate preparation.

## Archive contents

The closed release allowlist includes `dist/`, migrations, configuration,
operational scripts, `package.json`, `yarn.lock`, `.yarnrc.yml`, and the pinned
Yarn 4.13.0 runtime. It excludes dependency trees, caches, credentials, and
runtime data.

## Preparation flow

1. Verify the signed archive and extract the candidate as today.
2. Permit outbound HTTPS only for `yarn install --immutable --production`.
3. Use only `https://registry.npmjs.org`; no registry credentials or private
   registry configuration are accepted.
4. Disable network after installation, validate the prepared tree, and proceed
   through the existing activation path.

Any download, lockfile, integrity, native-module, or install failure rejects the
candidate before PM2 is stopped. The current release remains live.

## Boundaries

- Native modules are installed for the Pi at preparation time; this Mac never
  provides a target dependency tree.
- The activation helper remains network-disabled and never runs package
  installation.
- The candidate network permission is limited to the dependency-install step;
  all later preparation and runtime paths retain their existing restrictions.
- The signed archive still binds the compiled application and lockfile. The
  registry supplies only lockfile-pinned dependency bytes.

## Verification

Tests must prove that archives contain no dependency tree/cache, that a locked
registry install succeeds only during the allowed preparation phase, that a
failure retains the live release, and that all later phases remain network
disabled.
