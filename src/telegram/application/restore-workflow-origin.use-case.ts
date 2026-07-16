import { Injectable } from '@nestjs/common';
import type { HomeIdentity, HomeView } from '../domain/home-session';
import type { Locale } from '../domain/locale';
import type { ResolveWorkflowOriginInput } from './resolve-workflow-origin.use-case';
import { ResolveWorkflowOriginUseCase } from './resolve-workflow-origin.use-case';
import { OpenHomeUseCase } from './open-home.use-case';

export type RestoreWorkflowOriginInput = ResolveWorkflowOriginInput & {
  locale: Locale;
  notice?: string;
};

export type RestoreWorkflowOriginResult =
  | { kind: 'opened'; active: HomeIdentity; view: HomeView }
  | { kind: 'resumable' };

@Injectable()
export class RestoreWorkflowOriginUseCase {
  constructor(
    private readonly resolve: ResolveWorkflowOriginUseCase,
    private readonly openHome: OpenHomeUseCase,
  ) {}

  async execute(input: RestoreWorkflowOriginInput): Promise<RestoreWorkflowOriginResult> {
    const view = await this.resolve.execute(input);
    const result = await this.openHome.execute({
      userId: input.userId,
      chatId: input.chatId,
      locale: input.locale,
      role: input.role,
      view,
      notice: input.notice,
    });
    return result.kind === 'opened' ? result : { kind: 'resumable' };
  }
}
