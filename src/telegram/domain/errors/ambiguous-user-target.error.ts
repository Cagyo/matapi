import { User } from '../user.entity';

export type AmbiguousUserTargetCandidate = Readonly<
  Pick<User, 'telegramId' | 'name'>
>;

export class AmbiguousUserTargetError extends Error {
  readonly code = 'AMBIGUOUS_USER_TARGET' as const;

  constructor(
    readonly query: string,
    readonly matches: readonly AmbiguousUserTargetCandidate[],
  ) {
    super(`User target '${query}' is ambiguous`);
    this.name = 'AmbiguousUserTargetError';
  }
}
