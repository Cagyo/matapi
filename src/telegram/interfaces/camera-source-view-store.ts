import {
  CAMERA_SOURCE_ABANDONED_TTL_MS,
  type CameraSourcePromptPhase,
} from '../domain/camera-source-prompt';
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
 * How long a prompt's *routing* is kept, which is deliberately **not** the
 * screen window above and deliberately **not** the prompt window either.
 *
 * Routing has to outlive the prompt it routes to. The durable row is the sole
 * authority on what a reply may do, and past `expiresAt` its answer is `late` —
 * "delete this message, authorise nothing". That answer is only reachable if
 * something still routes the reply to it, so a routing entry that expired with
 * the prompt would take the entire cleanup path with it: `promptFor` finds
 * nothing, `handleText` hands the message to the next handler, and a
 * credential-bearing reply is never deleted. Retention keeps credential
 * tombstones for 24 hours precisely so a late reply is still cleanable; routing
 * is what makes that reachable, so it is bounded by the same horizon.
 *
 * Beyond it the row itself has been pruned as abandoned, and Telegram stops
 * letting a bot delete a message at roughly 48 hours anyway — so past this
 * point there is nothing left to route to and nothing left to delete.
 */
export const CAMERA_SOURCE_PROMPT_ROUTING_TTL_MS = CAMERA_SOURCE_ABANDONED_TTL_MS;

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
   *
   * A prompt is keyed by the message it forces a reply to, **not** by its
   * receipt, and that is a correctness requirement rather than a convenience.
   * Routing and screens have different lifetimes: a screen is superseded by the
   * next screen of the same workflow, while a prompt stays answerable until the
   * message it names is answered or expires. Sharing a key made every ordinary
   * render — a stale inline button pressed on an older message, or Sources
   * re-opened from the dashboard, which calls `clear` outright — silently drop
   * the routing for a live credential prompt. The durable row survived that and
   * would have claimed cleanly; nothing looked it up, so `handleText` handed a
   * credential-bearing message to the next handler and it was never deleted.
   *
   * Eviction still reaches prompts, and must: it is keyed on the *receipt*, so
   * a prompt left over from a superseded workflow is dropped exactly as before
   * and cannot resume an install the administrator has navigated away from.
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
    this.states.set(this.keyFor(state, ctx), state);
  }

  clear(ctx: TelegramContext, receiptId: string): void {
    this.states.delete(this.key(ctx, receiptId));
  }

  /**
   * Forgets one prompt's routing, by the message it forced a reply to.
   *
   * `clear` cannot do this any more and must not: it names a receipt, and a
   * receipt's screen being replaced is precisely the event that has to leave a
   * live prompt answerable. Spending a prompt is a different act with a
   * different key.
   */
  clearPrompt(userId: number, chatId: number, promptMessageId: number): void {
    this.states.delete(promptKey(userId, chatId, promptMessageId));
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

  /**
   * Forgets one receipt's screens, or every screen this administrator has here
   * — **including their prompts**.
   *
   * Matched on the receipt each state carries rather than on its key, which is
   * what keeps this correct now that a prompt is keyed by its message: a
   * cancelled workflow ends its prompts, while a *rendered* screen does not.
   * That is the whole distinction `clear` and `set` now respect, and cancelling
   * is the side of it that still sweeps everything.
   */
  cancel(userId: number, chatId: number, receiptId?: string): void {
    for (const [key, state] of this.states) {
      if (state.receipt.userId !== userId || state.receipt.chatId !== chatId) continue;
      if (receiptId !== undefined && state.receipt.id !== receiptId) continue;
      this.states.delete(key);
    }
  }

  /** The messages this receipt still has forcing a reply, newest first. */
  promptMessagesFor(userId: number, chatId: number, receiptId: string): number[] {
    return this.promptsFor(userId, chatId, receiptId).map((state) => state.promptMessageId);
  }

  /**
   * Every prompt this administrator has open here, newest first — optionally
   * narrowed to one receipt.
   *
   * Whole states rather than message identifiers, because a caller ending a
   * prompt needs the receipt it belongs to in order to name its durable row,
   * and — when Telegram refuses the retraction — the state itself to put back.
   * Without the receipt a caller sweeping *across* receipts would have to
   * fabricate one, and a fabricated receipt names the wrong row.
   */
  promptsFor(userId: number, chatId: number, receiptId?: string): readonly CameraSourcePromptView[] {
    return this.statesFor(userId, chatId).filter(
      (state): state is CameraSourcePromptView =>
        state.kind === 'prompt'
        && (receiptId === undefined || state.receipt.id === receiptId)
        // The same horizon `promptFor` routes on. These two disagreeing is what
        // let retraction believe a prompt was alive while routing believed it
        // was dead — with the message alive in the chat either way.
        && !this.expired(state),
    );
  }

  /**
   * Re-arms the routing for a prompt whose retraction Telegram refused.
   *
   * The message is still in the chat and still answerable, so forgetting it
   * would strand it — a credential replied to an unroutable prompt reaches the
   * next handler undeleted, which is the one outcome this workflow exists to
   * prevent. Deliberately *not* `set`: `set` evicts other receipts' states, and
   * this runs while a newer workflow's screen is legitimately in the store.
   */
  restorePrompt(state: CameraSourcePromptView): void {
    this.states.set(this.keyFor(state), state);
  }

  /**
   * Whether a live screen exists. Read across the handler boundary by
   * `CameraHandler.cancelExact`, whose `'missing'` answer is what raises the
   * interrupted-workflow notice — so an expired entry is dropped here rather
   * than reported as pending.
   */
  hasPending(userId: number, chatId: number, receiptId?: string): boolean {
    let pending = false;
    for (const state of this.statesFor(userId, chatId)) {
      if (receiptId !== undefined && state.receipt.id !== receiptId) continue;
      if (this.expired(state)) {
        this.states.delete(this.keyFor(state));
        continue;
      }
      // Prompts are excluded *deliberately*, and this is the one place that
      // distinction is worth spelling out. Routing outlives the workflow that
      // armed it: answering a prompt does not spend its routing, because a
      // second credential pasted at the same prompt still has to be deleted.
      // So a surviving routing entry says "a message in this chat may still
      // need cleaning up", not "this administrator is still mid-workflow" —
      // and the caller, `CameraHandler.cancelExact`, is asking the second
      // question. Counting routing here would report a finished install as
      // pending for another 24 hours.
      //
      // This was previously achieved by accident: the lookup built a receipt
      // key, which a prompt — keyed by its message — could never match. Same
      // answer, but for no stated reason, and silently wrong the moment
      // anything else was keyed that way.
      if (state.kind === 'prompt') continue;
      pending = true;
    }
    return pending;
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

  /**
   * Whether an entry has aged out — on the window that applies to *its kind*.
   *
   * A screen and a prompt measure different things. Losing a screen costs a
   * reload; losing a prompt's routing costs a credential left in the chat. They
   * were the same ten minutes, and because the screen test is `>` while the
   * durable claim test is `>=`, the two windows disagreed at exactly one
   * instant: `now === expiresAt` routed and cleaned up, one millisecond later
   * the routing was gone and the reply went to the next handler undeleted.
   */
  private expired(state: CameraSourceViewState): boolean {
    const window = state.kind === 'prompt'
      ? CAMERA_SOURCE_PROMPT_ROUTING_TTL_MS
      : CAMERA_SOURCE_VIEW_TTL_MS;
    return this.now() - state.createdAtMs > window;
  }

  /**
   * Keyed by the *context's* identity, while `keyFor` keys by the receipt's.
   * They agree for every update this screen serves; the split is preserved
   * because eviction has to be able to name an entry it did not just look up.
   */
  private key(ctx: TelegramContext, receiptId: string): string {
    return `${ctx.from?.id ?? 'none'}:${ctx.chat?.id ?? 'none'}:${receiptId}`;
  }

  /**
   * The key one state lives under. A prompt is named by its message, every
   * other screen by its receipt — written once, so a reader cannot store an
   * entry under one key and delete it under another.
   */
  private keyFor(state: CameraSourceViewState, ctx?: TelegramContext): string {
    if (state.kind === 'prompt') {
      return promptKey(state.receipt.userId, state.receipt.chatId, state.promptMessageId);
    }
    return ctx
      ? this.key(ctx, state.receipt.id)
      : `${state.receipt.userId}:${state.receipt.chatId}:${state.receipt.id}`;
  }
}

/**
 * A prompt's key. The `p` segment cannot collide with a receipt's, which is
 * always exactly sixteen characters from `[A-Za-z0-9_-]`.
 */
function promptKey(userId: number, chatId: number, promptMessageId: number): string {
  return `${userId}:${chatId}:p:${promptMessageId}`;
}
