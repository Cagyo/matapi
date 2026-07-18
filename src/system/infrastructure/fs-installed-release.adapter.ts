import { constants } from "node:fs";
import { lstat, open, readlink, type FileHandle } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { parseArtifactMarker } from "../domain/ota-contracts";
import {
  InstalledReleaseError,
  type InstalledReleasePort,
} from "../domain/ports/installed-release.port";
import { artifactDirectoryName } from "../domain/release-identity";

const MAX_ARTIFACT_STATE_BYTES = 128 * 1024;

async function readBounded(handle: FileHandle): Promise<Buffer> {
  const metadata = await handle.stat();
  if (
    !metadata.isFile() ||
    metadata.size < 1 ||
    metadata.size > MAX_ARTIFACT_STATE_BYTES
  ) {
    throw new Error("invalid artifact state file");
  }
  const bytes = await handle.readFile();
  if (bytes.byteLength > MAX_ARTIFACT_STATE_BYTES)
    throw new Error("artifact state file is oversized");
  return bytes;
}

function isDirectChild(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path.length > 0 &&
    !path.startsWith(`..${sep}`) &&
    path !== ".." &&
    !path.includes(sep)
  );
}

export class FsInstalledReleaseAdapter implements InstalledReleasePort {
  constructor(private readonly root = "/opt/home-worker") {}

  async loadCurrent() {
    try {
      const currentPath = resolve(this.root, "current");
      const current = await lstat(currentPath);
      if (!current.isSymbolicLink())
        throw new Error("current is not a symlink");

      const target = await readlink(currentPath);
      const releasesRoot = resolve(this.root, "releases");
      const releasePath = resolve(this.root, target);
      if (
        !target.startsWith(`releases/`) ||
        !isDirectChild(releasesRoot, releasePath)
      ) {
        throw new Error("current target escapes releases");
      }

      const releaseBefore = await lstat(releasePath);
      if (releaseBefore.isSymbolicLink() || !releaseBefore.isDirectory())
        throw new Error("release target is invalid");

      const markerPath = resolve(releasePath, "artifact-state.json");
      const handle = await open(
        markerPath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      let markerBytes: Buffer;
      try {
        markerBytes = await readBounded(handle);
      } finally {
        await handle.close();
      }

      const marker = parseArtifactMarker(markerBytes);
      if (
        artifactDirectoryName(marker.artifact) !==
        relative(releasesRoot, releasePath)
      ) {
        throw new Error("current target does not match artifact identity");
      }

      const releaseAfter = await lstat(releasePath);
      if (
        releaseAfter.isSymbolicLink() ||
        !releaseAfter.isDirectory() ||
        releaseAfter.dev !== releaseBefore.dev ||
        releaseAfter.ino !== releaseBefore.ino ||
        (await readlink(currentPath)) !== target
      ) {
        throw new Error("current target changed during resolution");
      }
      return marker.artifact;
    } catch (error) {
      if (error instanceof InstalledReleaseError) throw error;
      throw new InstalledReleaseError();
    }
  }
}
