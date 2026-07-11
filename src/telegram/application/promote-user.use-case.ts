import { Inject, Injectable } from '@nestjs/common';
import { AlreadyAdminError } from '../domain/errors/already-admin.error';
import {
  USER_REPOSITORY,
  UserRepositoryPort,
} from '../domain/ports/user-repository.port';
import { User } from '../domain/user.entity';
import { ResolveUserTargetUseCase } from './resolve-user-target.use-case';

/** Spec 11 — `/promote <user>` (admin only). */
@Injectable()
export class PromoteUserUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    private readonly targets = new ResolveUserTargetUseCase(users),
  ) {}

  async execute(target: string): Promise<User> {
    const user = await this.targets.execute(target);
    if (user.role === 'admin') throw new AlreadyAdminError(user.name);
    return this.users.updateRole(user.telegramId, 'admin');
  }
}
