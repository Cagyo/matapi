import { Injectable } from '@nestjs/common';
import { DriveQuota, DriveStatusPort } from '../domain/ports/drive-status.port';

/** Dev/test `DriveStatusPort`. Returns a fixed, plausible quota. */
@Injectable()
export class StubDriveStatusAdapter implements DriveStatusPort {
  async about(): Promise<DriveQuota> {
    const totalBytes = 15 * 1024 ** 3;
    const usedBytes = Math.round(8.2 * 1024 ** 3);
    return { totalBytes, usedBytes, freeBytes: totalBytes - usedBytes };
  }
}
