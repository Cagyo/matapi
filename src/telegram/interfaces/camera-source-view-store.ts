import type { CameraSourcePromptPhase } from '../domain/camera-source-prompt';
import type { WorkflowReturnReceipt } from '../domain/workflow-return';
import type { TelegramContext } from './telegram-context';

/**
 * How long this screen remembers where an administrator was.
 *
 * Deliberately equal to `CAMERA_SOURCE_PROMPT_TTL_MS` and deliberately not
 * derived from it: they measure different things that happen to agree. The
 * prompt window is a promise made to the administrator about a credential and
 * is enforced durably; this is how long a *view* is worth keeping in a process
 * that may restart at any time. Losing one costs a reload; losing the other
 * costs a conversation.
 */
export const CAMERA_SOURCE_VIEW_TTL_MS = 10 * 60_000;

/**
 * Everything the RTSP source screens remember between two Telegram updates.
 *
 * Navigation only, and nothing that could not be re-derived: a receipt, which
 * page was last rendered, which opaque selector was opened, and the revision
 * that detail was read at. No camera identifier, no display name, no address,
 * no credential — a lost or expired entry costs a reload, never a wrong write.
 */
export type CameraSourceViewState =
  | { kind: 'overview'; receipt: WorkflowReturnReceipt; page: number; createdAtMs: number }
  | {
      kind: 'detail';
      receipt: WorkflowReturnReceipt;
      selector: string;
      revision: number;
      page: number;
      createdAtMs: number;
    }
  /**
   * A ForceReply is outstanding. This is routing, not state: it says which
   * receipt a reply to *that* message belongs to and whether the answer will be
   * a name or an address, and nothing else. The prompt's contents — the camera
   * it names, the proposed display name, its deadline — live in the durable
   * row, which is also the only authority on whether the reply may be acted on.
   */
  | {
      kind: 'prompt';
      receipt: WorkflowReturnReceipt;
      promptMessageId: number;
      phase: CameraSourcePromptPhase;
      page: number;
      createdAtMs: number;
    };

export type CameraSourcePromptView = Extract<CameraSourceViewState, { kind: 'prompt' }>;

/**
 * The in-process memory behind the RTSP source screens.
 *
 * Split out from `CameraSourcesHandler` so the two depend on this value rather
 * than on each other: the handler decides what to show and what to write, and
 * this decides only what is still worth remembering. Nothing here reaches
 * Telegram, the Camera boundary or the durable prompt store, which is what
 * makes the ten-minute window testable by calling a function rather than by
 * driving an update through a whole conversation.
 *
 * It holds no secret by construction — see `CameraSourceViewState` — and every
 * entry is expendable: an expired or evicted state costs one reload.
 */
export class CameraSourceViewStore {
  private readonly states = new Map<string, CameraSourceViewState>();

  /** `now` is supplied rather than read, so a test can move time without a clock port. */
  constructor(private readonly now: () => number) {}

  /**
   * Remembers one state, evicting whatever this administrator had under a
   * *different* receipt in the same chat: one workflow at a time per chat, so a
   * screen opened from a newer receipt cannot be answered by an older one.
   */
  set(ctx: TelegramContext, state: CameraSourceViewState): void {
    for (const [key, existing] of this.states) {
      if (
        existing.receipt.userId === state.receipt.userId
        && existing.receipt.chatId === state.receipt.chatId
        && existing.receipt.id !== state.receipt.id
      ) {
        this.states.delete(key);
      }
    }
    this.states.set(this.key(ctx, state.receipt.id), state);
  }

  clear(ctx: TelegramContext, receiptId: string): void {
    this.states.delete(this.key(ctx, receiptId));
  }

  /** The live state for this receipt, dropping it if the window has closed. */
  current(ctx: TelegramContext, receiptId: string): CameraSourceViewState | undefined {
    const state = this.states.get(this.key(ctx, receiptId));
    if (state && this.expired(state)) {
      this.states.delete(this.keyFor(state));
      return undefined;
    }
    return state;
  }

  /** The page a screen was last rendered from, or the first. */
  rememberedPage(ctx: TelegramContext, receiptId: string): number {
    return this.current(ctx, receiptId)?.page ?? 1;
  }

  /** The live prompt a message replies to, if this administrator owns one. */
  promptFor(userId: number, chatId: number, promptMessageId: number): CameraSourcePromptView | undefined {
    return this.statesFor(userId, chatId).find(
      (state): state is CameraSourcePromptView =>
        state.kind === 'prompt'
        && state.promptMessageId === promptMessageId
        && !this.expired(state),
    );
  }

  /** Forgets one receipt's screen, or every screen this administrator has here. */
  cancel(userId: number, chatId: number, receiptId?: string): void {
    if (receiptId) {
      this.states.delete(`${userId}:${chatId}:${receiptId}`);
      return;
    }
    for (const key of this.states.keys()) {
      if (key.startsWith(`${userId}:${chatId}:`)) this.states.delete(key);
    }
  }

  /**
   * Whether a live screen exists. Read across the handler boundary by
   * `CameraHandler.cancelExact`, whose `'missing'` answer is what raises the
   * interrupted-workflow notice — so an expired entry is dropped here rather
   * than reported as pending.
   */
  hasPending(userId: number, chatId: number, receiptId?: string): boolean {
    const state = receiptId
      ? this.states.get(`${userId}:${chatId}:${receiptId}`)
      : this.statesFor(userId, chatId).at(0);
    if (!state) return false;
    if (this.expired(state)) {
      this.states.delete(this.keyFor(state));
      return false;
    }
    return true;
  }

  /**
   * This screen's live states for one administrator in one chat, newest first.
   *
   * The chat half of that filter is a convenience, **not** the chat binding. A
   * reply is bound to its chat durably, by the prompt row's composite primary
   * key `(userId, chatId, receiptId, promptMessageId)`: `handleText` passes the
   * *message's* own `chatId` to `claimReply`, so a state matched across chats
   * would resolve to no row, return `stale`, authorise no Camera work, and
   * leave only the deletion — which is the right outcome wherever the message
   * landed. The scenario is not constructible anyway: `handleText` refuses a
   * non-private chat, and Telegram's private chat identifier equals the user's.
   *
   * Recorded because it cuts both ways. A reader may not drop this filter
   * believing it redundant — it is what keeps one administrator's two chats
   * from sharing a screen — and a test written to prove it enforces the chat
   * binding can only ever pass vacuously, because the primary key gets there
   * first.
   */
  private statesFor(userId: number, chatId: number): CameraSourceViewState[] {
    return [...this.states.values()]
      .filter((state) => state.receipt.userId === userId && state.receipt.chatId === chatId)
      .sort((left, right) => right.createdAtMs - left.createdAtMs);
  }

  private expired(state: CameraSourceViewState): boolean {
    return this.now() - state.createdAtMs > CAMERA_SOURCE_VIEW_TTL_MS;
  }

  /**
   * Keyed by the *context's* identity, while `keyFor` keys by the receipt's.
   * They agree for every update this screen serves; the split is preserved
   * because eviction has to be able to name an entry it did not just look up.
   */
  private key(ctx: TelegramContext, receiptId: string): string {
    return `${ctx.from?.id ?? 'none'}:${ctx.chat?.id ?? 'none'}:${receiptId}`;
  }

  private keyFor(state: CameraSourceViewState): string {
    return `${state.receipt.userId}:${state.receipt.chatId}:${state.receipt.id}`;
  }
}
