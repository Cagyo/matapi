import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { createLiveViewSettingsCandidate, parsePrivateCameraCidr, type LiveViewSettingsCandidate } from '../../camera/domain/live-view-settings';
import type { PrivateSubnetSuggestion } from '../../camera/domain/ports/private-subnet-detector.port';
import { CLOCK, type ClockPort } from '../../events/domain/ports/clock.port';
import { WorkflowDraftRegistry, type WorkflowDraftCanceller } from './workflow-draft.registry';

interface DraftIdentity { receiptId: string; userId: number; chatId: number }
export interface LiveViewSettingsDraft extends DraftIdentity {
  readonly expectedGeneration: number;
  candidate: LiveViewSettingsCandidate;
  suggestions: readonly PrivateSubnetSuggestion[];
  suggestionPage: number;
  pendingNormalization: { entered: string; canonical: string } | null;
  expiresAtMs: number;
  phase: 'status' | 'networks' | 'manual' | 'normalization' | 'review';
  /** Each reply is a new screen; old page/entry selectors cannot target it. */
  messageId: number | null;
}
export type DraftEntryResult = 'added' | 'duplicate' | 'limit' | 'invalid' | 'normalization' | 'stale';

@Injectable()
export class LiveViewSettingsDraftRegistry implements OnModuleInit, WorkflowDraftCanceller {
  private readonly drafts = new Map<string, LiveViewSettingsDraft>();

  constructor(
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(WorkflowDraftRegistry) private readonly workflows: WorkflowDraftRegistry,
  ) {}

  onModuleInit(): void { this.workflows.register('live-view-settings', this); }

  create(input: DraftIdentity & { expectedGeneration: number; candidate: LiveViewSettingsCandidate }): LiveViewSettingsDraft {
    for (const draft of this.drafts.values()) {
      if (draft.expiresAtMs <= this.clock.now().getTime()
        || (draft.userId === input.userId && draft.chatId === input.chatId)) this.drafts.delete(draft.receiptId);
    }
    const draft: LiveViewSettingsDraft = {
      ...input, candidate: createLiveViewSettingsCandidate(input.candidate), suggestions: [],
      suggestionPage: 0, pendingNormalization: null, expiresAtMs: this.clock.now().getTime() + 600_000,
      phase: 'status', messageId: null,
    };
    this.drafts.set(input.receiptId, draft);
    return draft;
  }

  resolve(identity: DraftIdentity): { kind: 'found'; draft: LiveViewSettingsDraft } | { kind: 'missing' | 'mismatched' | 'expired' } {
    const draft = this.drafts.get(identity.receiptId);
    if (!draft) return { kind: 'missing' };
    if (draft.userId !== identity.userId || draft.chatId !== identity.chatId) return { kind: 'mismatched' };
    if (draft.expiresAtMs <= this.clock.now().getTime()) {
      this.drafts.delete(identity.receiptId);
      return { kind: 'expired' };
    }
    return { kind: 'found', draft };
  }

  association(userId: number, chatId: number): LiveViewSettingsDraft | null {
    return [...this.drafts.values()].find(draft => draft.userId === userId && draft.chatId === chatId) ?? null;
  }

  async cancelExact(identity: DraftIdentity): Promise<'cancelled' | 'missing' | 'superseded'> {
    const draft = this.drafts.get(identity.receiptId);
    if (!draft) return 'missing';
    if (draft.userId !== identity.userId || draft.chatId !== identity.chatId) return 'superseded';
    this.drafts.delete(identity.receiptId);
    return 'cancelled';
  }

  cancelUser(userId: number): void {
    for (const draft of this.drafts.values()) if (draft.userId === userId) this.drafts.delete(draft.receiptId);
  }

  addManual(draft: LiveViewSettingsDraft, entered: string): DraftEntryResult {
    draft.pendingNormalization = null;
    try {
      const parsed = parsePrivateCameraCidr(entered);
      if (parsed.normalizedHostBits) {
        draft.pendingNormalization = { entered: entered.trim(), canonical: parsed.canonical };
        return 'normalization';
      }
      return this.add(draft, parsed.canonical);
    } catch { return 'invalid'; }
  }

  confirmNormalization(draft: LiveViewSettingsDraft): DraftEntryResult {
    const pending = draft.pendingNormalization;
    draft.pendingNormalization = null;
    return pending ? this.add(draft, pending.canonical) : 'stale';
  }

  addSuggestion(draft: LiveViewSettingsDraft, page: number, selector: number): DraftEntryResult {
    const suggestion = draft.suggestions.find(item => item.selector === String(selector));
    return draft.suggestionPage === page && suggestion ? this.add(draft, suggestion.cidr) : 'stale';
  }

  remove(draft: LiveViewSettingsDraft, selector: number): void {
    draft.candidate = { ...draft.candidate, allowedCameraCidrs: draft.candidate.allowedCameraCidrs.filter((_, index) => index !== selector) };
  }

  private add(draft: LiveViewSettingsDraft, cidr: string): DraftEntryResult {
    if (draft.candidate.allowedCameraCidrs.includes(cidr)) return 'duplicate';
    if (draft.candidate.allowedCameraCidrs.length >= 16) return 'limit';
    draft.candidate = createLiveViewSettingsCandidate({ ...draft.candidate, allowedCameraCidrs: [...draft.candidate.allowedCameraCidrs, cidr] });
    return 'added';
  }
}
