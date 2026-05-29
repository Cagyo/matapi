import { Inject, Injectable } from '@nestjs/common';
import { NotAdminError } from '../domain/errors/not-admin.error';
import { UserNotFoundError } from '../domain/errors/user-not-found.error';
import {
  USER_REPOSITORY,
  UserRepositoryPort,
} from '../domain/ports/user-repository.port';
import { User } from '../domain/user.entity';

/** Spec 11 — `/demote <user>` (admin only). Self-demotion is allowed. */
@Injectable()
export class DemoteUserUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
  ) {}

  async execute(target: string): Promise<User> {
    const user = await this.users.findByName(target);
    if (!user) throw new UserNotFoundError(target);
    if (user.role !== 'admin') throw new NotAdminError(user.name);
    return this.users.updateRole(user.telegramId, 'user');
  }
}
