import { Inject, Injectable } from '@nestjs/common';
import {
  SYSTEM_DEPS,
  SystemDepsCheck,
  SystemDepsPort,
} from '../../system/domain/ports/system-deps.port';

/**
 * Spec 18 — `/system_update`. Admin-only at the handler layer.
 *
 * Two-phase, mirroring `/import_config`: `check()` computes the
 * installed-vs-available diff for the confirmation UI, and `apply()`
 * spawns the detached update script once the admin confirms.
 */
@Injectable()
export class SystemUpdateUseCase {
  constructor(@Inject(SYSTEM_DEPS) private readonly deps: SystemDepsPort) {}

  check(): Promise<SystemDepsCheck> {
    return this.deps.check();
  }

  apply(): Promise<void> {
    return this.deps.applyUpdate();
  }
}
