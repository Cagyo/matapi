import type { ArtifactIdentity } from "../ota-contracts";

export const INSTALLED_RELEASE = Symbol("INSTALLED_RELEASE");

export class InstalledReleaseError extends Error {
  readonly code = "maintenance-required" as const;

  constructor() {
    super("maintenance-required");
    this.name = "InstalledReleaseError";
  }
}

export interface InstalledReleasePort {
  loadCurrent(): Promise<ArtifactIdentity>;
}
