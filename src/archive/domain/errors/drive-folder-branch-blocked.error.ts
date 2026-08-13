export class DriveFolderBranchBlockedError extends Error {
  readonly code = 'DRIVE_FOLDER_BRANCH_BLOCKED' as const;

  constructor() {
    super('Drive motion folder branch is blocked');
    this.name = 'DriveFolderBranchBlockedError';
  }
}
