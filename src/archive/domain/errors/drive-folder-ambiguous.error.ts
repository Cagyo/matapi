export class DriveFolderAmbiguousError extends Error {
  readonly code = "DRIVE_FOLDER_AMBIGUOUS" as const;

  constructor(message = "Drive managed folder is ambiguous") {
    super(message);
    this.name = "DriveFolderAmbiguousError";
  }
}
