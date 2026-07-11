import { User } from '../user.entity';

export class AmbiguousUserTargetError extends Error {
  readonly code = 'AMBIGUOUS_USER_TARGET' as const;

  constructor(
    readonly query: string,
    readonly matches: readonly Pick<User, 'telegramId' | 'name'>[],
  ) {
    super(`User target '${query}' is ambiguous`);
    this.name = 'AmbiguousUserTargetError';
  }
}
