import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, ClockPort } from '../../events/domain/ports/clock.port';
import { AdminAlreadyClaimedError } from '../domain/errors/admin-already-claimed.error';
import { AdminClaimNotConfiguredError } from '../domain/errors/admin-claim-not-configured.error';
import { InvalidAdminClaimTokenError } from '../domain/errors/invalid-admin-claim-token.error';
import {
  ADMIN_CLAIM_CREDENTIAL,
  AdminClaimCredentialPort,
} from '../domain/ports/admin-claim-credential.port';
import {
  USER_REPOSITORY,
  UserRepositoryPort,
} from '../domain/ports/user-repository.port';
import { DEFAULT_LOCALE } from '../domain/locale';
import { User } from '../domain/user.entity';

export interface ClaimAdminInput {
  telegramId: number;
  name: string;
  token: string;
}

/**
 * Spec 11 / spec 06 — first sender of `/claim_admin` becomes admin.
 * Throws `AdminAlreadyClaimedError` on every subsequent call.
 */
@Injectable()
export class ClaimAdminUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(ADMIN_CLAIM_CREDENTIAL)
    private readonly credential: AdminClaimCredentialPort,
  ) {}

  async execute(input: ClaimAdminInput): Promise<User> {
    if ((await this.users.countAdmins()) > 0) {
      throw new AdminAlreadyClaimedError();
    }
    if (!this.credential.isConfigured()) {
      throw new AdminClaimNotConfiguredError();
    }
    if (!this.credential.verify(input.token)) {
      throw new InvalidAdminClaimTokenError();
    }

    const admin = await this.users.claimFirstAdmin({
      telegramId: input.telegramId,
      name: input.name,
      role: 'admin',
      locale: DEFAULT_LOCALE,
      createdAt: this.clock.now(),
    });
    if (!admin) throw new AdminAlreadyClaimedError();
    return admin;
  }
}
