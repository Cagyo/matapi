import { Inject, Injectable } from '@nestjs/common';
import { UpdateInProgressError } from '../../system/domain/errors/update-in-progress.error';
import { OTA, OtaPort, UpdateCheck } from '../../system/domain/ports/ota.port';

export type UpdateOutcome =
  | { kind: 'up-to-date' }
  | { kind: 'started'; commit: string };

/** Spec 13 — `/update`. Admin-only at the handler layer. */
@Injectable()
export class UpdateSystemUseCase {
  constructor(@Inject(OTA) private readonly ota: OtaPort) {}

  async execute(): Promise<UpdateOutcome> {
    if (await this.ota.isLocked()) throw new UpdateInProgressError();
    const check: UpdateCheck = await this.ota.checkForUpdates();
    if (!check.hasUpdates) return { kind: 'up-to-date' };
    await this.ota.startUpdate();
    return { kind: 'started', commit: check.remoteCommit };
  }
}
