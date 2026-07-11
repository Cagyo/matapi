import { Inject, Injectable } from '@nestjs/common';
import { AmbiguousUserTargetError } from '../domain/errors/ambiguous-user-target.error';
import { UserNotFoundError } from '../domain/errors/user-not-found.error';
import {
  USER_REPOSITORY,
  UserRepositoryPort,
} from '../domain/ports/user-repository.port';
import { User } from '../domain/user.entity';

@Injectable()
export class ResolveUserTargetUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
  ) {}

  async execute(target: string): Promise<User> {
    const idMatch = /^id:(\d+)$/.exec(target.trim());
    if (idMatch) {
      const telegramId = Number(idMatch[1]);
      const user = Number.isSafeInteger(telegramId)
        ? await this.users.findByTelegramId(telegramId)
        : null;
      if (!user) throw new UserNotFoundError(target);
      return user;
    }

    const matches = await this.users.findByName(target);
    if (matches.length === 0) throw new UserNotFoundError(target);
    if (matches.length > 1) {
      throw new AmbiguousUserTargetError(target, matches);
    }
    return matches[0];
  }
}
