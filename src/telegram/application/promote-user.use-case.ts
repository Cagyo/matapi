import { Inject, Injectable } from '@nestjs/common';
import { AlreadyAdminError } from '../domain/errors/already-admin.error';
import { UserNotFoundError } from '../domain/errors/user-not-found.error';
import {
  USER_REPOSITORY,
  UserRepositoryPort,
} from '../domain/ports/user-repository.port';
import { User } from '../domain/user.entity';

/** Spec 11 — `/promote <user>` (admin only). */
@Injectable()
export class PromoteUserUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
  ) {}

  async execute(target: string): Promise<User> {
    const user = await this.users.findByName(target);
    if (!user) throw new UserNotFoundError(target);
    if (user.role === 'admin') throw new AlreadyAdminError(user.name);
    return this.users.updateRole(user.telegramId, 'admin');
  }
}
