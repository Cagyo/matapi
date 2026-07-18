import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parseReleaseName } from "../domain/release-identity";

const RELEASE_DIRECTORY_MODE = 0o755;

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export class ReleasePathGateway {
  constructor(
    private readonly releasesRoot: string,
    private readonly expectedUid: number | undefined = process.getuid?.(),
  ) {}

  async resolveChild(name: string): Promise<string> {
    parseReleaseName(name);
    if (basename(name) !== name) {
      throw new Error("release name must be a direct-child basename");
    }

    const root = await lstat(this.releasesRoot);
    this.assertDirectory(root, "release root");
    const rootHandle = await open(
      this.releasesRoot,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const openedRoot = await rootHandle.stat();
      this.assertDirectory(openedRoot, "release root");
      if (!sameFile(root, openedRoot)) {
        throw new Error("release root changed while resolving child");
      }

      const childPath = resolve(this.releasesRoot, name);
      const child = await lstat(childPath);
      this.assertDirectory(child, "release child");
      const childHandle = await open(
        childPath,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        const openedChild = await childHandle.stat();
        this.assertDirectory(openedChild, "release child");
        if (!sameFile(child, openedChild)) {
          throw new Error("release child changed while resolving path");
        }
      } finally {
        await childHandle.close();
      }
      return childPath;
    } finally {
      await rootHandle.close();
    }
  }

  private assertDirectory(entry: Stats, label: string): void {
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`${label} must be a non-symlink directory`);
    }
    if (this.expectedUid !== undefined && entry.uid !== this.expectedUid) {
      throw new Error(`${label} has the wrong owner`);
    }
    if ((entry.mode & 0o777) !== RELEASE_DIRECTORY_MODE) {
      throw new Error(`${label} must have mode 0755`);
    }
  }
}
