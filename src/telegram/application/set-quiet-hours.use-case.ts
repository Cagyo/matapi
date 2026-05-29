import { Inject, Injectable } from '@nestjs/common';
import { parseQuietHoursRange } from '../domain/quiet-hours.value-object';
import {
  USER_REPOSITORY,
  UserRepositoryPort,
} from '../domain/ports/user-repository.port';

export interface QuietHoursResult {
  /** `null` when disabled. */
  start: string | null;
  end: string | null;
}

/** Spec 12 — `/quiet_hours HH:MM-HH:MM | off`. */
@Injectable()
export class SetQuietHoursUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
  ) {}

  async execute(userId: number, raw: string): Promise<QuietHoursResult> {
    const range = parseQuietHoursRange(raw);
    if (!range) {
      await this.users.setQuietHours(userId, null, null);
      return { start: null, end: null };
    }
    await this.users.setQuietHours(userId, range.start, range.end);
    return { start: range.start, end: range.end };
  }
}
