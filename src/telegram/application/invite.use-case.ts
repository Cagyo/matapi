import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, ClockPort } from '../../events/domain/ports/clock.port';
import { InviteCode } from '../domain/invite-code.entity';
import {
  INVITE_CODE_REPOSITORY,
  InviteCodeRepositoryPort,
} from '../domain/ports/invite-code-repository.port';
import { Role } from '../domain/role';

export interface InviteInput {
  invitedBy: number;
  role?: Role;
}

export const INVITE_CODE_GENERATOR = Symbol('INVITE_CODE_GENERATOR');
export type InviteCodeGenerator = () => string;

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const MAX_ATTEMPTS = 5;

export const defaultInviteCodeGenerator: InviteCodeGenerator = () => {
  const bytes = randomBytes(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
};

/** Spec 11 — issues a one-time invite code (default role: `user`). */
@Injectable()
export class InviteUseCase {
  constructor(
    @Inject(INVITE_CODE_REPOSITORY)
    private readonly invites: InviteCodeRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(INVITE_CODE_GENERATOR)
    private readonly generate: InviteCodeGenerator,
  ) {}

  async execute(input: InviteInput): Promise<InviteCode> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const code = this.generate();
      const existing = await this.invites.findByCode(code);
      if (existing) {
        lastError = new Error(`invite code collision: ${code}`);
        continue;
      }
      return this.invites.create({
        code,
        role: input.role ?? 'user',
        createdBy: input.invitedBy,
        createdAt: this.clock.now(),
      });
    }
    throw lastError instanceof Error
      ? lastError
      : new Error('failed to generate unique invite code');
  }
}
