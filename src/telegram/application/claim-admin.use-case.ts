import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, ClockPort } from '../../events/domain/ports/clock.port';
import { AdminAlreadyClaimedError } from '../domain/errors/admin-already-claimed.error';
import {
  USER_REPOSITORY,
  UserRepositoryPort,
} from '../domain/ports/user-repository.port';
import { User } from '../domain/user.entity';

export interface ClaimAdminInput {
  telegramId: number;
  name: string;
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
  ) {}

  async execute(input: ClaimAdminInput): Promise<User> {
    const adminCount = await this.users.countAdmins();
    if (adminCount > 0) {
      throw new AdminAlreadyClaimedError();
    }

    return this.users.createAdmin({
      telegramId: input.telegramId,
      name: input.name,
      role: 'admin',
      createdAt: this.clock.now(),
    });
  }
}
