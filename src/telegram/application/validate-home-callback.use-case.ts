import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type ClockPort } from '../../events/domain/ports/clock.port';
import type { ParsedHomeCallback } from '../domain/home-callback';
import type { ValidateHomeResult } from '../domain/home-session';
import {
  HOME_SESSION_STORE,
  type HomeSessionStorePort,
} from '../domain/ports/home-session-store.port';

export interface ValidateHomeCallbackInput {
  parsed: ParsedHomeCallback;
  userId: number;
  chatId: number;
  messageId: number;
}

@Injectable()
export class ValidateHomeCallbackUseCase {
  constructor(
    @Inject(HOME_SESSION_STORE) private readonly sessions: HomeSessionStorePort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  execute(input: ValidateHomeCallbackInput): Promise<ValidateHomeResult> {
    return this.sessions.validate({
      userId: input.userId,
      chatId: input.chatId,
      messageId: input.messageId,
      token: input.parsed.token,
      revision: input.parsed.revision,
      now: this.clock.now(),
    });
  }
}
