import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { PendingDriveConnection } from '../../archive/application/use-cases/begin-drive-connection.use-case';
import { CancelDriveConnectionUseCase } from '../../archive/application/use-cases/cancel-drive-connection.use-case';
import { DriveSetupExpiredError } from '../../archive/domain/errors/drive-setup-expired.error';
import { CLOCK, type ClockPort } from '../../events/domain/ports/clock.port';
import {
  WorkflowDraftRegistry,
  type WorkflowDraftCanceller,
} from './workflow-draft.registry';

export interface DriveSetupIdentity {
  userId: number;
  chatId: number;
  receiptId: string;
}

export interface DriveSetupGenerationIdentity extends DriveSetupIdentity {
  generationId: string;
}

export type DriveSetupState =
  | (DriveSetupIdentity & {
      kind: 'preparing';
      preparationExpiresAtMs: number;
    })
  | (DriveSetupIdentity & {
      kind: 'authorizing';
      preparationExpiresAtMs: number;
      pending: PendingDriveConnection;
      effectiveDeadlineMs: number | null;
      controller: AbortController;
    });

type AuthorizingDriveSetupState = Extract<DriveSetupState, { kind: 'authorizing' }>;

/** Owns the transient, secret-free state of exact Drive connection setup attempts. */
@Injectable()
export class DriveSetupStateRegistry implements OnModuleInit, WorkflowDraftCanceller {
  private readonly states = new Map<string, DriveSetupState>();

  constructor(
    @Inject(CLOCK) private readonly clock: ClockPort,
    private readonly cancelConnection: CancelDriveConnectionUseCase,
    private readonly drafts: WorkflowDraftRegistry,
  ) {}

  onModuleInit(): void {
    this.drafts.register('drive-setup', this);
  }

  prepare(input: DriveSetupIdentity & { preparationExpiresAtMs: number }): void {
    const current = this.states.get(key(input));
    if (current?.kind === 'authorizing' || (current && current.receiptId !== input.receiptId)) {
      throw new RangeError('Drive setup replacement was not cancelled first');
    }
    this.states.set(key(input), { kind: 'preparing', ...input });
  }

  removePreparation(identity: DriveSetupIdentity): boolean {
    const state = this.exact(identity);
    if (state?.kind !== 'preparing') return false;
    return this.states.delete(key(identity));
  }

  association(input: { userId: number; chatId: number }): DriveSetupState | null {
    return this.states.get(key(input)) ?? null;
  }

  authorizing(input: DriveSetupGenerationIdentity): AuthorizingDriveSetupState | null {
    return this.exactGeneration(input);
  }

  claimAuthorizing(
    identity: DriveSetupIdentity,
    pending: PendingDriveConnection,
  ): AuthorizingDriveSetupState | null {
    const state = this.exact(identity);
    if (state?.kind !== 'preparing') return null;
    if (state.preparationExpiresAtMs <= this.clock.now().getTime()) throw new DriveSetupExpiredError();
    const next: AuthorizingDriveSetupState = {
      ...state,
      kind: 'authorizing',
      pending,
      effectiveDeadlineMs: null,
      controller: new AbortController(),
    };
    this.states.set(key(identity), next);
    return next;
  }

  recordChallenge(input: DriveSetupGenerationIdentity & { effectiveDeadlineMs: number }): boolean {
    const state = this.exactGeneration(input);
    if (!state || input.effectiveDeadlineMs <= this.clock.now().getTime()
      || input.effectiveDeadlineMs > state.pending.expiresAtMs) return false;
    this.states.set(key(input), { ...state, effectiveDeadlineMs: input.effectiveDeadlineMs });
    return true;
  }

  returnToPreparing(input: DriveSetupGenerationIdentity): boolean {
    const state = this.exactGeneration(input);
    if (!state) return false;
    state.controller.abort(new DOMException('Drive setup initial operation ended', 'AbortError'));
    this.states.set(key(input), {
      kind: 'preparing',
      userId: state.userId,
      chatId: state.chatId,
      receiptId: state.receiptId,
      preparationExpiresAtMs: state.preparationExpiresAtMs,
    });
    return true;
  }

  observeAuthorized(input: DriveSetupGenerationIdentity): AuthorizingDriveSetupState | null {
    return this.exactGeneration(input);
  }

  takeTerminal(input: DriveSetupGenerationIdentity): AuthorizingDriveSetupState | null {
    return this.takeAuthorizing(input);
  }

  takeActivated(input: DriveSetupGenerationIdentity): AuthorizingDriveSetupState | null {
    return this.takeAuthorizing(input);
  }

  async cancelExact(input: DriveSetupIdentity): Promise<'cancelled' | 'missing' | 'superseded'> {
    const state = this.exact(input);
    if (!state) return this.states.has(key(input)) ? 'superseded' : 'missing';
    this.states.delete(key(input));
    if (state.kind === 'preparing') return 'cancelled';
    state.controller.abort(new DOMException('Drive setup cancelled', 'AbortError'));
    await this.cancelConnection.execute({
      generationId: state.pending.generationId,
      receiptId: state.receiptId,
      adminUserId: state.userId,
      chatId: state.chatId,
    });
    return 'cancelled';
  }

  async cancelUser(userId: number): Promise<void> {
    const owned = [...this.states.values()].filter((state) => state.userId === userId);
    for (const state of owned) await this.cancelExact(state);
  }

  private takeAuthorizing(input: DriveSetupGenerationIdentity): AuthorizingDriveSetupState | null {
    const state = this.exactGeneration(input);
    if (!state) return null;
    this.states.delete(key(input));
    state.controller.abort(new DOMException('Drive setup completed', 'AbortError'));
    return state;
  }

  private exact(input: DriveSetupIdentity): DriveSetupState | null {
    const state = this.states.get(key(input));
    return state?.receiptId === input.receiptId ? state : null;
  }

  private exactGeneration(input: DriveSetupGenerationIdentity): AuthorizingDriveSetupState | null {
    const state = this.exact(input);
    return state?.kind === 'authorizing' && state.pending.generationId === input.generationId
      ? state
      : null;
  }
}

function key(input: { userId: number; chatId: number }): string {
  return `${input.userId}:${input.chatId}`;
}
