import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, ClockPort } from '../../events/domain/ports/clock.port';
import { AlreadyRegisteredError } from '../domain/errors/already-registered.error';
import { InvalidInviteCodeError } from '../domain/errors/invalid-invite-code.error';
import { InviteCodeUsedError } from '../domain/errors/invite-code-used.error';
import {
  INVITE_CODE_REPOSITORY,
  InviteCodeRepositoryPort,
} from '../domain/ports/invite-code-repository.port';
import {
  USER_REPOSITORY,
  UserRepositoryPort,
} from '../domain/ports/user-repository.port';
import { DEFAULT_LOCALE } from '../domain/locale';
import { User } from '../domain/user.entity';

export interface RegisterUserInput {
  telegramId: number;
  name: string;
  code: string;
}

export interface RegisterUserResult {
  user: User;
  invitedBy: number | null;
}

/** Spec 11 — `/start <code>` redeems a one-time invite code. */
@Injectable()
export class RegisterUserUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(INVITE_CODE_REPOSITORY)
    private readonly invites: InviteCodeRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(input: RegisterUserInput): Promise<RegisterUserResult> {
    const existingUser = await this.users.findByTelegramId(input.telegramId);
    if (existingUser) throw new AlreadyRegisteredError(input.telegramId);

    const invite = await this.invites.findByCode(input.code);
    if (!invite) throw new InvalidInviteCodeError(input.code);
    if (invite.usedAt !== null || invite.usedBy !== null) {
      throw new InviteCodeUsedError(input.code);
    }

    const now = this.clock.now();
    // Claim the code atomically FIRST — the conditional update is the real gate
    // against concurrent redemption. Only create the user once the code is ours.
    const claimed = await this.invites.redeem(invite.code, input.telegramId, now);
    if (!claimed) throw new InviteCodeUsedError(input.code);

    const user = await this.users.createUser({
      telegramId: input.telegramId,
      name: input.name,
      role: invite.role,
      locale: DEFAULT_LOCALE,
      createdAt: now,
    });

    return { user, invitedBy: invite.createdBy };
  }
}
