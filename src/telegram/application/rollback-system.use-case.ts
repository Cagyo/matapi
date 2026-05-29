import { Inject, Injectable } from '@nestjs/common';
import { UpdateInProgressError } from '../../system/domain/errors/update-in-progress.error';
import { OTA, OtaPort } from '../../system/domain/ports/ota.port';

/** Spec 13 — `/rollback`. Admin-only at the handler layer. */
@Injectable()
export class RollbackSystemUseCase {
  constructor(@Inject(OTA) private readonly ota: OtaPort) {}

  async execute(): Promise<void> {
    if (await this.ota.isLocked()) throw new UpdateInProgressError();
    await this.ota.startRollback();
  }
}
