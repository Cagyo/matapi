import type {
  ArtifactIdentity,
  CheckedReleaseIdentity,
  MetadataIdentity,
} from "./ota-contracts";

const SHA256 = /^[0-9a-f]{64}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export interface ParsedReleaseName {
  version: string;
  artifactSha256: string;
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

export function isCanonicalVersion(value: unknown): value is string {
  return typeof value === "string" && SEMVER.test(value);
}

export function artifactDirectoryName(artifact: ArtifactIdentity): string {
  if (!isCanonicalVersion(artifact.version) || !isSha256(artifact.sha256)) {
    throw new Error("artifact identity has a non-canonical release name");
  }
  return `${artifact.version}-${artifact.sha256}`;
}

export function parseReleaseName(value: unknown): ParsedReleaseName {
  if (typeof value !== "string")
    throw new Error("release name must be a string");
  const separator = value.lastIndexOf("-");
  if (separator <= 0) throw new Error("release name is not canonical");

  const version = value.slice(0, separator);
  const artifactSha256 = value.slice(separator + 1);
  if (!isCanonicalVersion(version) || !isSha256(artifactSha256)) {
    throw new Error("release name is not canonical");
  }
  return { version, artifactSha256 };
}

export function sameArtifact(
  left: ArtifactIdentity,
  right: ArtifactIdentity,
): boolean {
  return (
    left.version === right.version &&
    left.commit === right.commit &&
    left.targetName === right.targetName &&
    left.target.platform === right.target.platform &&
    left.target.arch === right.target.arch &&
    left.target.libc === right.target.libc &&
    left.target.libcMinVersion === right.target.libcMinVersion &&
    left.target.nodeModulesAbi === right.target.nodeModulesAbi &&
    left.url === right.url &&
    left.format === right.format &&
    left.size === right.size &&
    left.expandedSize === right.expandedSize &&
    left.maxPreparedSize === right.maxPreparedSize &&
    left.maxPreparedFiles === right.maxPreparedFiles &&
    left.fileCount === right.fileCount &&
    left.sha256 === right.sha256
  );
}

export function sameMetadata(
  left: MetadataIdentity,
  right: MetadataIdentity,
): boolean {
  return (
    left.metadataVersion === right.metadataVersion &&
    left.channel === right.channel &&
    left.payloadSha256 === right.payloadSha256 &&
    left.publishedAt === right.publishedAt &&
    left.expiresAt === right.expiresAt
  );
}

export function sameCheckedRelease(
  left: CheckedReleaseIdentity,
  right: CheckedReleaseIdentity,
): boolean {
  return (
    sameArtifact(left.artifact, right.artifact) &&
    sameMetadata(left.metadata, right.metadata)
  );
}
