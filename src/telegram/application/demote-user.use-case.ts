import { Inject, Injectable } from '@nestjs/common';
import { LastAdminDemotionError } from '../domain/errors/last-admin-demotion.error';
import { NotAdminError } from '../domain/errors/not-admin.error';
import {
  USER_REPOSITORY,
  UserRepositoryPort,
} from '../domain/ports/user-repository.port';
import { User } from '../domain/user.entity';
import { ResolveUserTargetUseCase } from './resolve-user-target.use-case';

/** Spec 11 — `/demote <user>` (admin only). Always retains one admin. */
@Injectable()
export class DemoteUserUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    private readonly targets: ResolveUserTargetUseCase,
  ) {}

  async execute(target: string): Promise<User> {
    const user = await this.targets.execute(target);
    if (user.role !== 'admin') throw new NotAdminError(user.name);
    const demoted = await this.users.demoteAdminIfNotLast(user.telegramId);
    if (!demoted) throw new LastAdminDemotionError();
    return demoted;
  }
}
