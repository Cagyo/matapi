import { DriveTemporaryUnavailableError } from "./drive-temporary-unavailable.error";

export class DriveFolderDiscoveryUncertainError extends DriveTemporaryUnavailableError {
  readonly code = "DRIVE_FOLDER_DISCOVERY_UNCERTAIN" as const;

  constructor() {
    super("Google Drive folder discovery is temporarily incomplete");
    this.name = "DriveFolderDiscoveryUncertainError";
  }
}
