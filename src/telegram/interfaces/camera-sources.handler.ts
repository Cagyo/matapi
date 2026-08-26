import { Inject, Injectable, Optional } from '@nestjs/common';
import { AttachRtspSourceUseCase } from '../../camera/application/attach-rtsp-source.use-case';
import { CreateRtspCameraUseCase } from '../../camera/application/create-rtsp-camera.use-case';
import {
  GetRtspSourceOverviewUseCase,
  type RtspSourceOverview,
  type RtspSourcesOverviewPage,
} from '../../camera/application/get-rtsp-source-overview.use-case';
import { ListCamerasUseCase } from '../../camera/application/list-cameras.use-case';
import { RemoveRtspSourceUseCase } from '../../camera/application/remove-rtsp-source.use-case';
import { ReplaceRtspSourceUseCase } from '../../camera/application/replace-rtsp-source.use-case';
import { TestRtspSourceUseCase } from '../../camera/application/test-rtsp-source.use-case';
import { cameraNameKey } from '../../camera/domain/camera-name-key';
import { CameraSourceUnavailableError } from '../../camera/domain/errors/camera-source-unavailable.error';
import { LiveSourceStateChangedError } from '../../camera/domain/errors/live-source-state-changed.error';
import type { RedactedLiveSource } from '../../camera/domain/ports/live-source-repository.port';
import { RTSP_SOURCE_CAMERA_TYPE } from '../../camera/domain/ports/rtsp-source-configuration.port';
import { CLOCK, type ClockPort } from '../../events/domain/ports/clock.port';
import { catalogFor, type LocaleCatalog } from '../../locales';
import {
  CAMERA_SOURCE_MESSAGE,
  type CameraSourceMessagePort,
} from '../application/ports/camera-source-message.port';
import {
  CAMERA_SOURCE_PROMPT_REPOSITORY,
  type CameraSourcePromptRepositoryPort,
} from '../application/ports/camera-source-prompt-repository.port';
import {
  CAMERA_SOURCE_PROMPT_TTL_MS,
  createCameraSourcePrompt,
  type CameraSourcePrompt,
  type CameraSourcePromptIdentity,
  type CameraSourcePromptOperation,
  type CameraSourcePromptPhase,
  type NewCameraSourcePrompt,
} from '../domain/camera-source-prompt';
import type { WorkflowReturnReceipt } from '../domain/workflow-return';
import { presentCameraSourceError } from './camera-source-error.presenter';
import { CameraSourceViewStore, type CameraSourcePromptView } from './camera-source-view-store';
import { FeatureHandler } from './feature.handler';
import {
  addBody,
  addKeyboard,
  attachBody,
  attachKeyboard,
  CANCEL_ACTION,
  cancelKeyboard,
  credentialPromptBody,
  detailBody,
  detailKeyboard,
  detailsBody,
  detailsKeyboard,
  forceReply,
  namePromptBody,
  overviewBody,
  overviewKeyboard,
  privacyNoticeBody,
  recoveryKeyboard,
  REINSTALL_ACTION,
  removalBody,
  removalConfirmAction,
  removalKeyboard,
  SELECTOR_LENGTH,
  sourceSelector,
  startAgainKeyboard,
  type CameraSourceCopy,
  type CameraSourceRecoveryTargets,
} from './camera-source.presenter';
import type { TelegramContext } from './telegram-context';
import { WorkflowEntryCoordinator, type WorkflowLaunch } from './workflow-entry.coordinator';
import { WorkflowNavigationHandler } from './workflow-navigation.handler';
import { FeatureUnavailableError } from '../../features/domain/errors/feature-unavailable.error';
import { FEATURE_AVAILABILITY, type FeatureAvailabilityPort } from '../../features/domain/ports/feature-availability.port';

/**
 * Rows per rendered page.
 *
 * Deliberately distinct from the Camera use case's own
 * `RTSP_SOURCE_OVERVIEW_PAGE_SIZE`: that constant is the default for callers
 * that express no preference, while this one is how many rows *this screen*
 * can show without a Telegram keyboard becoming unreadable. Presentation owns
 * its page size and passes it explicitly; it stays inside the use case's
 * `RTSP_SOURCE_OVERVIEW_MAX_PAGE_SIZE` ceiling, which exists to bound the DNS
 * fan-out one page costs.
 */
const SOURCE_PAGE_SIZE = 8;
const PAGE_ACTION = /^p:([1-9][0-9]{0,15})$/;
// Derived from the presenter's selector width rather than restated, so the two
// cannot drift into a screen that renders selectors its own router rejects.
const DETAIL_ACTION = new RegExp(`^d:([A-Za-z0-9_-]{${SELECTOR_LENGTH}})$`);
const ATTACH_ACTION = new RegExp(`^add:s:([A-Za-z0-9_-]{${SELECTOR_LENGTH}})$`);
const ATTACH_PAGE_ACTION = /^add:a:([1-9][0-9]{0,15})$/;
/**
 * The removal confirm control: a selector and the revision the confirmation
 * screen was rendered from. Sixteen digits is `Number.MAX_SAFE_INTEGER`'s
 * width, which is the widest a revision can legitimately be, and the whole
 * callback still fits Telegram's 64 bytes with room to spare.
 */
const REMOVE_CONFIRM_ACTION = new RegExp(
  `^rm:y:([A-Za-z0-9_-]{${SELECTOR_LENGTH}}):([0-9]{1,16})$`,
);

/**
 * Stands in for the message identifier while a prompt's *shape* is checked,
 * before there is a message to identify. Any positive integer the model accepts
 * would do; the real identifier is validated when the row is actually minted.
 */
const PROMPT_SHAPE_PROBE_MESSAGE_ID = 1;

/** The only selection a name prompt ever carries: a create, nothing chosen yet. */
const CREATE_SELECTION: CameraSourceSelection = {
  operation: 'create',
  cameraId: null,
  displayName: null,
  expectedRevision: null,
};

/**
 * The prompt window, in the unit the copy asks for. Derived from the model's
 * own constant rather than restated: the number in `privacyNotice` is a promise
 * about `expiresAt`, and two independent tens would only agree until one moved.
 */
const PROMPT_TTL_MINUTES = CAMERA_SOURCE_PROMPT_TTL_MS / 60_000;

/** Same ceiling `cameras.name`, the prompt model and the create use case accept. */
const MAX_DISPLAY_NAME_LENGTH = 64;

/**
 * Shapes a display name may not take, mirroring the prompt model's own guard: a
 * name that looks like an address or carries userinfo is refused before it can
 * be written to a durable row.
 */
const NAME_SECRET_SHAPE = /:\/\/|@|rtsps?:/i;

/**
 * Whether an address asks for TLS. `RtspSourceInput` requires an explicit TLS
 * mode and the Camera domain refuses one that disagrees with the scheme, so the
 * mode is read off the scheme here rather than guessed. Nothing else about the
 * address is parsed on this side of the boundary.
 */
const STRICT_TLS_SCHEME = /^\s*rtsps:/i;

/**
 * An address, and whether the message that carried it is gone.
 *
 * Produced only by `takeAddressAndDelete`, consumed only by `install`. Its
 * whole purpose is to be the token that proves a deletion was attempted: a
 * `string` parameter would let a future edit call `install` with an address
 * read anywhere, which is exactly the ordering this workflow cannot lose.
 */
interface CredentialReply {
  readonly address: string;
  readonly deleted: boolean;
}

/**
 * The non-secret selection a credential prompt is minted around.
 *
 * `expectedRevision` is the fence, and it lives on the durable row rather than
 * in memory for the same reason the rest of this does: the address arrives in a
 * later update, possibly after a restart, and the revision it must be committed
 * against is the one the administrator was shown — not whatever the source has
 * moved to by then. A first install has nothing to fence and carries `null`.
 */
interface CameraSourceSelection {
  operation: CameraSourcePromptOperation;
  cameraId: string | null;
  displayName: string | null;
  expectedRevision: number | null;
}

/** Status-first RTSP sources. CameraHandler validates `cam:<receipt>:src*` before delegating here. */
@Injectable()
export class CameraSourcesHandler {
  private readonly views = new CameraSourceViewStore(() => this.now());

  constructor(
    private readonly overview: GetRtspSourceOverviewUseCase,
    private readonly cameras: ListCamerasUseCase,
    private readonly createCamera: CreateRtspCameraUseCase,
    private readonly attachSource: AttachRtspSourceUseCase,
    private readonly replaceSource: ReplaceRtspSourceUseCase,
    private readonly testSource: TestRtspSourceUseCase,
    private readonly removeSource: RemoveRtspSourceUseCase,
    @Inject(CAMERA_SOURCE_PROMPT_REPOSITORY)
    private readonly prompts: CameraSourcePromptRepositoryPort,
    @Inject(CAMERA_SOURCE_MESSAGE) private readonly messages: CameraSourceMessagePort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    private readonly workflows: WorkflowEntryCoordinator,
    @Optional() private readonly navigation?: WorkflowNavigationHandler,
    @Optional() @Inject(FEATURE_AVAILABILITY) private readonly availability?: FeatureAvailabilityPort,
    /**
     * The feature workflow, for the one failure this screen cannot fix. Held
     * only to hand the conversation over — nothing here calls a feature
     * mutation, and an unwired handler degrades to copy rather than a throw.
     *
     * The token is explicit rather than inferred from the parameter type, and
     * that is not style: an `@Optional()` dependency Nest cannot resolve is
     * injected as `undefined` silently, so this one would degrade to "RTSP is
     * unavailable" copy in production with nothing to notice it by. An explicit
     * token also survives a transform that emits no `design:paramtypes`, which
     * is what the test container runs under.
     */
    @Optional() @Inject(FeatureHandler) private readonly features?: FeatureHandler,
  ) {}

  hasPending(userId: number, chatId: number, receiptId?: string): boolean {
    return this.views.hasPending(userId, chatId, receiptId);
  }

  /**
   * Opens on current state.
   *
   * Administrator and readiness are checked here rather than per action, so the
   * dashboard button and `/camera sources` cannot drift apart: both arrive at
   * this one entry point. A screen that cannot describe the camera network
   * cannot honestly offer to change it, so an unready RTSP renders the feature
   * notice instead of a menu.
   */
  async handleEntry(ctx: TelegramContext, launch?: WorkflowLaunch): Promise<void> {
    const receipt = launch?.receipt ?? (await this.workflows.begin(ctx, 'camera', { source: 'natural-parent' }));
    if (!receipt || !(await this.requireAdmin(ctx))) return;
    if (!(await this.requireRtsp(ctx))) return;
    // Before the first render, because rendering is what evicts them.
    const stranded = await this.retractSuperseded(receipt);
    this.views.clear(ctx, receipt.id);
    await this.showOverview(ctx, receipt, 1);
    // And put back the ones Telegram would not delete — *after* the render,
    // because the render's own eviction is what would otherwise forget them a
    // second time. Their rows are already terminal, so the routing that
    // survives here can only reach the cleanup branch: `claimReply` answers
    // `late`, the reply is deleted, and no install is authorised by it.
    for (const state of stranded) this.views.restorePrompt(state);
  }

  async handleCallback(ctx: TelegramContext, action: string, receipt: WorkflowReturnReceipt): Promise<void> {
    if (!(await this.workflows.validateCurrent(ctx, receipt))) return;
    if (!(await this.requireAdmin(ctx))) return;
    // Two actions run ahead of the readiness gate, which is where a list stops
    // being self-evident — so the rule, once, rather than two precedents: an
    // action that **ends** or **repairs** the unusable state runs ahead of the
    // gate; everything that reads or mutates a source runs behind it. A third
    // candidate is decided by that sentence, not by these two.
    //
    // Reinstalling repairs it: an administrator reaches for it *because* RTSP
    // is not usable, and refusing the escape hatch for the condition it exists
    // to clear would leave the workflow with no way forward at all.
    if (action === REINSTALL_ACTION) return this.handoffToReinstall(ctx, receipt);
    // Cancel ends it, and that is the stronger case of the two: RTSP can become
    // unusable **underneath an armed ForceReply**, and behind the gate this
    // would render the feature notice and return — leaving the prompt in the
    // chat with no control that ends it, which is the exact residual this
    // workflow spends three layers preventing.
    if (action === CANCEL_ACTION) return this.endCancelled(ctx, receipt);
    if (!(await this.requireRtsp(ctx))) return;

    const page = PAGE_ACTION.exec(action);
    if (page) return this.showOverview(ctx, receipt, Number(page[1]));
    const detail = DETAIL_ACTION.exec(action);
    if (detail) return this.showDetail(ctx, receipt, detail[1], this.views.rememberedPage(ctx, receipt.id));
    if (action === 'over') return this.showOverview(ctx, receipt, this.views.rememberedPage(ctx, receipt.id));
    if (action === 'info') return this.showDetails(ctx, receipt);
    if (action === 'add') return this.showAdd(ctx, receipt);
    if (action === 'add:c') return this.startCreate(ctx, receipt);
    if (action === 'add:a') return this.showAttachCandidates(ctx, receipt, 1);
    const attachPage = ATTACH_PAGE_ACTION.exec(action);
    if (attachPage) return this.showAttachCandidates(ctx, receipt, Number(attachPage[1]));
    const attach = ATTACH_ACTION.exec(action);
    if (attach) return this.startAttach(ctx, receipt, attach[1]);
    if (action === 'test') return this.runTest(ctx, receipt);
    if (action === 'addr') return this.startReplace(ctx, receipt);
    // `rm` asks; only `rm:y:<selector>:<revision>` retires anything, and the
    // revision it carries is the fence. A confirm whose shape this rejects
    // matches no arm at all, which is the same answer a stale button gets.
    if (action === 'rm') return this.showRemoval(ctx, receipt);
    const confirm = REMOVE_CONFIRM_ACTION.exec(action);
    if (confirm) return this.confirmRemoval(ctx, receipt, confirm[1], Number(confirm[2]));
    // No action here reuses a letter from the operation picker this screen
    // replaced, so a `src:a`/`src:e`/`src:t` button still sitting in an old
    // chat message resolves to nothing rather than to a different operation.
  }

  /**
   * Routes one message to the exact prompt it answers, or to nobody.
   *
   * Five things have to agree before this handler will even look at the text:
   * the chat is private, the sender is the administrator the prompt names, the
   * chat is the prompt's chat, the reply points at the prompt's own message,
   * and the durable row still permits one claim. An ordinary message — even one
   * that looks exactly like an RTSP address — matches none of them and is
   * handed straight back to the next handler.
   *
   * `false` means "not mine". Everything else returns `true`, including the
   * paths that only delete: once a credential reply has been recognised, no
   * other handler may see it.
   */
  async handleText(ctx: TelegramContext): Promise<boolean> {
    const message = ctx.message;
    // A prompt lives in a private chat by construction, and the durable model
    // refuses a negative chat identifier outright. Checking the type here is
    // what keeps a group message from ever reaching that refusal.
    if (ctx.chat?.type !== 'private') return false;
    if (!message || typeof message.text !== 'string') return false;
    const userId = ctx.from?.id;
    const chatId = ctx.chat.id;
    const promptMessageId = message.reply_to_message?.message_id;
    const replyMessageId = message.message_id;
    if (
      !isPositiveInteger(userId)
      || !isPositiveInteger(chatId)
      || !isPositiveInteger(promptMessageId)
      || !isPositiveInteger(replyMessageId)
    ) {
      return false;
    }
    const state = this.views.promptFor(userId, chatId, promptMessageId);
    if (!state) return false;

    // The durable row is the sole authority on what a reply may do, so the
    // routing is deliberately *not* spent here — it only says which receipt a
    // reply to this message belongs to, and the answer to that does not change
    // when the prompt is answered.
    //
    // Dropping it would suppress the one thing a repeat reply still needs. The
    // CAS below refuses to advance anything either way: a spent name prompt is
    // gone from the store and answers `stale`, and a spent credential prompt
    // answers `late`. But `late` is what reaches the cleanup branch that
    // *deletes the second message*, and that branch is unreachable if nothing
    // routed the reply to it — leaving a second pasted credential sitting in
    // the chat. The entry costs a page number and expires on its own window.
    const claim = await this.prompts.claimReply({
      userId,
      chatId,
      receiptId: state.receipt.id,
      promptMessageId,
      replyMessageId,
      now: this.clock.now(),
    });
    if (claim.kind === 'stale') {
      // The row is gone — pruned, or lost with the database — so there is
      // nothing to consume and no camera work to authorise. A credential reply
      // is still deleted: the message in the chat is real whatever the
      // repository remembers about it.
      if (state.phase !== 'credential') return false;
      // The outcome is discarded because there is no row left to record it on;
      // the retry still happens, because the message is what matters.
      await this.deleteWithRetry(chatId, replyMessageId);
      return true;
    }
    if (claim.prompt.phase === 'credential') {
      // A reply that lost the claim — already answered, or past the deadline —
      // is cleanup and nothing else: the message is deleted, retried once, and
      // no Camera work is authorised by it.
      if (claim.kind === 'late') {
        const deleted = await this.deleteWithRetry(chatId, replyMessageId);
        await this.finishPrompt(identityOf(claim.prompt), !deleted);
        // The same warning the winning path owes, for the same reason: a
        // refused deletion means the address is probably still in the chat,
        // and losing the claim does not make that any less true.
        if (!deleted) {
          await this.replyRetaining(() =>
            ctx.reply(this.copy(ctx).credentialDeletionFailed(promptCameraName(claim.prompt))));
        }
        await this.replyWindowClosed(ctx, state.receipt);
        return true;
      }
      await this.runCredentialReply(ctx, state.receipt, claim.prompt, replyMessageId, state.page);
      return true;
    }
    if (claim.kind === 'claimed') {
      await this.runNameReply(ctx, state.receipt, claim.prompt, message.text, state.page);
      return true;
    }
    // A name reply that lost the claim authorises nothing and echoes nothing —
    // but it is still an answer the administrator typed and watched go nowhere.
    // Silence here reads as a broken bot, which is what sends someone back to
    // paste the *address* into a prompt that can no longer take it.
    await this.replyWindowClosed(ctx, state.receipt);
    return true;
  }

  /**
   * The answer to a reply the workflow will not act on.
   *
   * Deliberately one message for both readings of `late`: a prompt whose ten
   * minutes ran out, and a prompt that was already spent. The administrator's
   * next move is identical, and it is the overview rather than a fresh prompt —
   * re-arming a ForceReply from a message sent to a dead one would start a
   * workflow nobody asked for, at exactly the moment the last one was lost.
   *
   * The window is passed rather than written into the copy, and `PROMPT_TTL_MINUTES`
   * is derived from `CAMERA_SOURCE_PROMPT_TTL_MS`: the number an administrator
   * reads here is a claim about `expiresAt`, and a restated ten would agree with
   * it only until one of them moved. A behavioural test cannot tell those two
   * apart — both render ten today — so the derivation itself is pinned at
   * source level, in `camera-sources.handler.test.ts`.
   */
  private async replyWindowClosed(ctx: TelegramContext, receipt: WorkflowReturnReceipt): Promise<void> {
    const copy = this.copy(ctx);
    await this.replyRetaining(() => ctx.reply(copy.prompts.expired(PROMPT_TTL_MINUTES), {
      reply_markup: startAgainKeyboard(copy, this.catalog(ctx).home.common, receipt.id),
    }));
  }

  /**
   * Whether this text is the administrator asking to stop, in their language.
   *
   * Read from the active catalog rather than from a list here, so a locale's
   * own words are the ones accepted for that locale — and the synonyms are
   * stored already normalized, so this normalizes the reply the same way rather
   * than re-deriving a rule per language.
   *
   * The comparison sees plaintext that may be a credential, and that is safe
   * for exactly one reason: it is a comparison. Nothing is captured, echoed,
   * stored or logged, and the only value that leaves is a boolean.
   */
  private isCancelSynonym(ctx: TelegramContext, text: string): boolean {
    const normalized = text.trim().toLowerCase();
    if (normalized === '') return false;
    return this.copy(ctx).cancelSynonyms.includes(normalized);
  }

  /**
   * Ends the workflow as cancelled: every prompt it still has open is retracted
   * *first*, then the receipt is completed and the outcome rendered.
   *
   * The order is the T6 invariant rather than a preference — a prompt whose
   * workflow ends must have its message retracted, not merely forgotten.
   * Completing first would forget the screen while an armed ForceReply was
   * still in the chat, and the credential answered into it would reach the next
   * handler undeleted. `retractPrompts` also handles Telegram refusing: the
   * routing is kept when the message is still there, so a reply is claimed
   * `late` and deleted as cleanup rather than acted on.
   *
   * Everything here is scoped to the receipt it is handed and cannot reach a
   * newer one: `retractPrompts` enumerates only the prompts *that* receipt
   * armed, and `complete` forgets only its screen. The Cancel control adds no
   * gate of its own on top of that — `handleCallback` has already established
   * the administrator and that the receipt is current before it routes here.
   */
  private async endCancelled(ctx: TelegramContext, receipt: WorkflowReturnReceipt): Promise<void> {
    await this.retractPrompts(receipt);
    await this.complete(ctx, receipt, () => ctx.reply(this.copy(ctx).prompts.cancelled));
  }

  /**
   * The Add fork, or the only screen it could lead to.
   *
   * Attaching is offered only when there is something to attach to, because a
   * fork with one live arm is a question the administrator cannot answer
   * wrongly but still has to read.
   */
  private async showAdd(ctx: TelegramContext, receipt: WorkflowReturnReceipt): Promise<void> {
    const overview = await this.loadOverview(ctx, receipt);
    if (!overview) return;
    if (overview.attachCandidates.length === 0) {
      await this.sendNamePrompt(ctx, receipt, overview.page);
      return;
    }
    this.views.set(ctx, { kind: 'overview', receipt, page: overview.page, createdAtMs: this.now() });
    const copy = this.copy(ctx);
    await ctx.reply(addBody(copy), {
      reply_markup: addKeyboard(copy, this.catalog(ctx).home.common, receipt.id),
    });
  }

  private async startCreate(ctx: TelegramContext, receipt: WorkflowReturnReceipt): Promise<void> {
    await this.sendNamePrompt(ctx, receipt, this.views.rememberedPage(ctx, receipt.id));
  }

  /** The cameras that could take a source, read fresh: the list moves under it. */
  private async showAttachCandidates(
    ctx: TelegramContext,
    receipt: WorkflowReturnReceipt,
    page: number,
  ): Promise<void> {
    const overview = await this.loadOverview(ctx, receipt);
    if (!overview) return;
    const candidates = overview.attachCandidates;
    if (candidates.length === 0) {
      await this.renderOverview(ctx, receipt, overview);
      return;
    }
    const pageCount = Math.max(1, Math.ceil(candidates.length / SOURCE_PAGE_SIZE));
    const current = Math.min(Math.max(page, 1), pageCount);
    const visible = candidates.slice((current - 1) * SOURCE_PAGE_SIZE, current * SOURCE_PAGE_SIZE);
    // The remembered page is the *source overview's*, not this list's. They
    // count different things, and the candidate page is carried in the callback
    // rather than remembered, so returning to the overview lands where the
    // administrator actually was.
    this.views.set(ctx, { kind: 'overview', receipt, page: overview.page, createdAtMs: this.now() });
    const copy = this.copy(ctx);
    try {
      await ctx.reply(attachBody(copy, current, pageCount), {
        reply_markup: attachKeyboard(
          copy,
          this.catalog(ctx).home.common,
          receipt.id,
          visible,
          current,
          pageCount,
        ),
      });
    } catch (error) {
      // Unlike the screens above, this reply is the one whose size depends on
      // how many cameras exist, so a rejection here is answered rather than
      // thrown past `handleCallback` into silence.
      await this.replyFailure(ctx, error);
    }
  }

  /**
   * Resolves the chosen camera against a freshly read candidate list, exactly
   * as `resolveSelected` does for a stored source: a camera that has since been
   * removed, disabled or given a source of its own simply is not found.
   */
  private async startAttach(
    ctx: TelegramContext,
    receipt: WorkflowReturnReceipt,
    selector: string,
  ): Promise<void> {
    const overview = await this.loadOverview(ctx, receipt);
    if (!overview) return;
    const candidate = overview.attachCandidates.find(
      (option) => sourceSelector(option.cameraId) === selector,
    );
    if (!candidate) {
      await this.renderOverview(ctx, receipt, overview);
      return;
    }
    await this.sendCredentialPrompt(ctx, receipt, overview, {
      operation: 'attach',
      cameraId: candidate.cameraId,
      // Filtered for the same reason `startReplace` filters: a stored camera
      // name is validated less strictly than a prompt row accepts, and the row
      // already names the camera by identifier. Nothing downstream needs it.
      displayName: usableDisplayName(candidate.cameraName),
      expectedRevision: null,
    });
  }

  /** The display-name half of a create, as an exact ForceReply. */
  private async sendNamePrompt(
    ctx: TelegramContext,
    receipt: WorkflowReturnReceipt,
    page: number,
  ): Promise<void> {
    if (!(await this.mintable(ctx, receipt, 'name', CREATE_SELECTION))) return;
    const copy = this.copy(ctx);
    const sent = await ctx.reply(namePromptBody(copy), { reply_markup: forceReply() });
    await this.rememberPrompt(ctx, receipt, sent.message_id, 'name', page, CREATE_SELECTION);
  }

  /**
   * The privacy notice, then the address prompt — in that order, always, and
   * only once a durable row is known to be able to back them.
   *
   * The notice is the only place an administrator learns what they are about to
   * hand Telegram, so it is sent *before* the control that invites them to do
   * it, and the networks it lists come from the page just read rather than from
   * anything this screen remembers.
   */
  private async sendCredentialPrompt(
    ctx: TelegramContext,
    receipt: WorkflowReturnReceipt,
    overview: RtspSourcesOverviewPage,
    selection: CameraSourceSelection,
  ): Promise<void> {
    if (!(await this.mintable(ctx, receipt, 'credential', selection))) return;
    const copy = this.copy(ctx);
    // The notice carries the workflow's only Cancel control, and it has to:
    // the prompt that follows is a ForceReply, and Telegram lets a message
    // carry one `reply_markup`, so the prompt itself cannot also hold a button.
    await ctx.reply(privacyNoticeBody(copy, overview.policy.networks, PROMPT_TTL_MINUTES), {
      reply_markup: cancelKeyboard(copy, receipt.id),
    });
    const sent = await ctx.reply(credentialPromptBody(copy), { reply_markup: forceReply() });
    await this.rememberPrompt(ctx, receipt, sent.message_id, 'credential', overview.page, selection);
  }

  /**
   * Answers the name prompt.
   *
   * The prompt is consumed first and unconditionally: a name reply holds no
   * secret, but it has already been claimed, and a row left `running` would be
   * swept by startup recovery instead of by the conversation that owns it. A
   * rejected name is answered with copy and a *new* exact prompt, so the
   * administrator never has to reopen the screen to try again.
   */
  private async runNameReply(
    ctx: TelegramContext,
    receipt: WorkflowReturnReceipt,
    prompt: CameraSourcePrompt,
    text: string,
    page: number,
  ): Promise<void> {
    await this.finishPrompt(identityOf(prompt), false);
    if (!(await this.requireAdmin(ctx))) return;
    // Checked against the prompt this reply actually claimed, which is what
    // makes a typed cancel *exact*: the same word sent as an ordinary message,
    // or replied to a prompt whose window has closed, never reaches here.
    if (this.isCancelSynonym(ctx, text)) {
      await this.endCancelled(ctx, receipt);
      return;
    }
    const name = usableDisplayName(text);
    if (name === null) {
      await ctx.reply(this.copy(ctx).prompts.invalidName);
      await this.sendNamePrompt(ctx, receipt, page);
      return;
    }
    // Cheap check before the expensive step, not instead of it — see
    // `nameAlreadyUsed`. Answered like any other rejected name: copy, and a
    // fresh exact prompt to try again on.
    if (await this.nameAlreadyUsed(name)) {
      await ctx.reply(this.copy(ctx).errors['name-taken']);
      await this.sendNamePrompt(ctx, receipt, page);
      return;
    }
    const overview = await this.loadOverview(ctx, receipt, page);
    if (!overview) return;
    await this.sendCredentialPrompt(ctx, receipt, overview, {
      operation: 'create',
      cameraId: null,
      displayName: name,
      expectedRevision: null,
    });
  }

  /**
   * Whether a camera already answers to this name. **Advice, not a decision.**
   *
   * The Camera boundary owns uniqueness: it holds the transaction, and any
   * check on this side is a TOCTOU window by construction. This exists because
   * the ordering without it is hostile — a duplicate name would be discovered
   * only *after* the administrator had read the privacy notice and pasted a
   * credential-bearing URL, and `name-taken`'s only recovery action is `back`,
   * so the whole conversation restarts and the URL has to be pasted again. The
   * expensive, irreversible step should not run to discover something a read
   * could have said first.
   *
   * A read that fails advises nothing and returns `false`: an advisory check
   * that blocked when it could not answer would be a blocking check with extra
   * steps, and would make an unreadable camera list a reason nobody can add a
   * camera. The authoritative rejection still arrives from the boundary.
   */
  private async nameAlreadyUsed(name: string): Promise<boolean> {
    try {
      const key = cameraNameKey(name);
      const cameras = await this.cameras.execute();
      return cameras.some((camera) => cameraNameKey(camera.name) === key);
    } catch {
      return false;
    }
  }

  /**
   * Answers the credential prompt. This is the one ordering in this file that
   * is not a matter of taste:
   *
   * 1. the durable `pending → running` claim has already happened, upstream;
   * 2. the address is copied into one local, in this frame;
   * 3. deletion of the reply is attempted **immediately**;
   * 4. only then is anything else allowed to happen — the actor's role, RTSP
   *    readiness, the address's own validity, the network policy and the probe
   *    are all downstream of the deletion, so none of them can decide the reply
   *    was not worth removing;
   * 5. a single retry in `finally`, and only when the first attempt failed;
   * 6. the prompt is consumed carrying the one non-secret bit that survives.
   *
   * The plaintext never leaves this frame. It is not stored on a field, not
   * written to the prompt row, not interpolated into copy, and not logged; the
   * only call it is passed to is the Camera use case that has to dial it.
   *
   * It *is* carried in a record — `CredentialReply` — and that is a deliberate
   * reversal of the plan's `CredentialReplyContext`, which was rejected for
   * carrying plaintext across a return boundary. The objection was to a record
   * that merely transported the address; this one is a token that also proves
   * something. Its only producer is `takeAddressAndDelete`, which has already
   * attempted the deletion, and its only consumer is `install`. So step 3
   * cannot be moved after step 4 by any edit: before the deletion there is no
   * `CredentialReply` to install. The ordering is a data dependency rather than
   * a convention about statement order — which is why breaking it fails nine
   * tests rather than the one or two that were watching call order.
   */
  private async runCredentialReply(
    ctx: TelegramContext,
    receipt: WorkflowReturnReceipt,
    prompt: CameraSourcePrompt,
    replyMessageId: number,
    page: number,
  ): Promise<void> {
    const reply = await this.takeAddressAndDelete(ctx, prompt.chatId, replyMessageId);
    let deleted = reply.deleted;
    // The role the middleware resolved for *this* update, read once and answered
    // after the deletion rather than instead of it: a revoked administrator
    // still gets their password taken out of the chat.
    const denied = ctx.localeState?.user.role !== 'admin';
    // Read from the same already-deleted reply, and deliberately *after* the
    // deletion rather than before it. A cancel word is not a credential, but
    // deciding that is a decision — and every decision in this method is
    // downstream of the deletion, so none of them can be the reason a reply
    // stayed in the chat. Cancelling therefore costs the message either way.
    const cancelled = this.isCancelSynonym(ctx, reply.address);
    let installed: RedactedLiveSource | null = null;
    let failure: unknown = null;
    try {
      if (!denied && !cancelled) {
        await this.availability?.requireReady('rtsp');
        await ctx.reply(this.copy(ctx).progress.testing);
        installed = await this.install(prompt, reply);
      }
    } catch (error) {
      failure = error;
    } finally {
      // Narrow by construction: one retry, only when the first attempt failed,
      // and nothing else in here that could throw past it.
      if (!reply.deleted) deleted = await this.attemptDeletion(prompt.chatId, replyMessageId);
    }

    await this.finishPrompt(identityOf(prompt), !deleted);
    // The prompt was spent when it was claimed, so the screen behind it has to
    // be put back before anything is rendered: an administrator who lands on a
    // failure is still where they started, and `complete` clears this again on
    // the one path that actually ends the workflow.
    //
    // A replacement goes back to the *detail* rather than the overview, and
    // that is load-bearing rather than tidy: its recovery controls act on one
    // source, and the selection they need lived in the prompt row that has just
    // been consumed. Create and attach have no stored source to return to.
    const selector = prompt.operation === 'replace' && prompt.cameraId !== null
      ? sourceSelector(prompt.cameraId)
      : null;
    this.views.set(ctx, selector === null
      ? { kind: 'overview', receipt, page, createdAtMs: this.now() }
      : {
          kind: 'detail',
          receipt,
          selector,
          // The revision this conversation was fenced on. Nothing acts on it:
          // every stored-source action re-reads through `openStoredSource`,
          // which overwrites this before it fences anything.
          revision: prompt.expectedRevision ?? 0,
          page,
          createdAtMs: this.now(),
        });
    if (!deleted) await ctx.reply(this.copy(ctx).credentialDeletionFailed(promptCameraName(prompt)));
    if (denied) {
      await this.replyRetaining(() => ctx.reply(this.catalog(ctx).common.adminRequired));
      return;
    }
    if (cancelled) {
      await this.endCancelled(ctx, receipt);
      return;
    }
    if (failure !== null) {
      if (selector === null) {
        await this.replyFailure(ctx, failure);
        return;
      }
      await this.replyRecovery(ctx, receipt, failure, selector, page, {
        // The address that made this request has already been deleted, so
        // there is no identical request left to re-run. Asking for another one
        // is `change-address`, and it is right there.
        retry: null,
        'change-address': 'addr',
        back: `d:${selector}`,
      });
      return;
    }
    const copy = this.copy(ctx);
    const name = prompt.displayName ?? installed?.cameraName ?? '';
    const outcome = prompt.operation === 'attach'
      ? copy.outcomes.attached(name)
      : prompt.operation === 'replace'
        ? copy.outcomes.replaced(name)
        : copy.outcomes.created(name);
    await this.complete(ctx, receipt, () => ctx.reply(outcome));
  }

  /**
   * The one call that sees the address. Both use cases take the same endpoint;
   * only the camera it is bound to differs.
   *
   * It takes a `CredentialReply` rather than a `string` on purpose: the only
   * way to obtain one is `takeAddressAndDelete`, which has already attempted
   * the deletion. The ordering is therefore a data dependency rather than a
   * convention about statement order — a check inserted between this call and
   * the reply arriving cannot come before the deletion, because before the
   * deletion there is no address to install.
   */
  private async install(prompt: CameraSourcePrompt, reply: CredentialReply): Promise<RedactedLiveSource> {
    // `LiveSource.create` defaults transport and profile to exactly these, but
    // `RtspSourceInput` requires them, and a default that moved there must not
    // silently move what an administrator's camera was given.
    const endpoint = {
      url: reply.address,
      transport: 'tcp',
      tlsMode: STRICT_TLS_SCHEME.test(reply.address) ? 'strict' : 'none',
      profile: 'eco',
      substream: null,
      actorUserId: prompt.userId,
    } as const;
    if (prompt.operation === 'attach' && prompt.cameraId !== null) {
      return this.attachSource.execute({ ...endpoint, cameraId: prompt.cameraId });
    }
    if (prompt.operation === 'create' && prompt.displayName !== null) {
      return this.createCamera.execute({ ...endpoint, displayName: prompt.displayName });
    }
    // The fence travels on the row, not in this frame: `expectedRevision` is
    // the revision the administrator was shown when they asked to change the
    // address, and it is what the swap is committed against however long the
    // typing took or how many restarts happened in between.
    if (
      prompt.operation === 'replace'
      && prompt.cameraId !== null
      && prompt.expectedRevision !== null
    ) {
      return this.replaceSource.execute({
        ...endpoint,
        cameraId: prompt.cameraId,
        expectedRevision: prompt.expectedRevision,
      });
    }
    // A stored prompt this conversation cannot execute — a selection or a
    // revision the row lost. Reported as the source having moved, which is the
    // one answer that offers no way to retry the address just deleted.
    throw new LiveSourceStateChangedError();
  }

  /**
   * Reads the address off the reply and deletes the message that carried it,
   * in that order, and hands back both facts as one value.
   *
   * This is the shape that makes "delete before any effect" enforceable rather
   * than merely observed: `install` cannot be handed an address that did not
   * come from here, and nothing can come from here without the deletion having
   * been attempted first. The five ordering tests still exist, but they now
   * describe the design instead of being the only thing holding it up.
   *
   * The plaintext is a return value of exactly one function and a parameter of
   * exactly one other. It is never stored, never logged, never rendered.
   */
  private async takeAddressAndDelete(
    ctx: TelegramContext,
    chatId: number,
    replyMessageId: number,
  ): Promise<CredentialReply> {
    const address = ctx.message?.text ?? '';
    return { address, deleted: await this.attemptDeletion(chatId, replyMessageId) };
  }

  /**
   * Deletion by identity, reduced to one bit.
   *
   * `CameraSourceMessagePort` fails closed, so a rejection means the message is
   * probably still there. The rejection itself is caught bindingless: it is
   * Telegram's, and Telegram's refusal quotes the chat and the message it
   * refused — which is the credential.
   */
  private async attemptDeletion(chatId: number, messageId: number): Promise<boolean> {
    try {
      await this.messages.delete(chatId, messageId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Deletion with the same single retry the credential path owes, for the paths
   * where nothing runs in between and so nothing needs a `finally`.
   */
  private async deleteWithRetry(chatId: number, messageId: number): Promise<boolean> {
    if (await this.attemptDeletion(chatId, messageId)) return true;
    return this.attemptDeletion(chatId, messageId);
  }

  /**
   * Takes a claimed prompt to its terminal state. A repository that refuses is
   * not fatal here: the row stays `running`, which is exactly the shape startup
   * recovery is built to finish, and the administrator still gets an answer.
   */
  private async finishPrompt(
    identity: CameraSourcePromptIdentity,
    deletionFailed: boolean,
    outcome: 'consumed' | 'expired' = 'consumed',
  ): Promise<void> {
    const now = this.clock.now();
    if (await this.terminalise(identity, deletionFailed, outcome)) await this.sweep(now);
  }

  /**
   * The terminal transition alone, without the sweep that usually follows it.
   *
   * Split out so a caller ending *several* prompts at once pays for retention
   * once rather than once per row: the sweep is bounded, predicated work, but
   * it is the same work whether one tombstone or five were just minted, and
   * nothing about a loop makes it more urgent per iteration.
   *
   * `false` means the store refused, which is not fatal — the row stays
   * `running`, which is exactly the shape startup recovery is built to finish —
   * and is the caller's signal that there is nothing new to sweep for.
   */
  private async terminalise(
    identity: CameraSourcePromptIdentity,
    deletionFailed: boolean,
    outcome: 'consumed' | 'expired',
  ): Promise<boolean> {
    const transition = { identity, deletionFailed, now: this.clock.now() };
    try {
      if (outcome === 'expired') await this.prompts.expire(transition);
      else await this.prompts.consume(transition);
      return true;
    } catch {
      // Bindingless: a better-sqlite3 rejection can quote the row it refused.
      return false;
    }
  }

  /**
   * The opportunistic half of retention, run only where a prompt has just
   * become terminal.
   *
   * Terminal transitions are the only events that *create* something to sweep —
   * a tombstone — and they are rare: at most one per conversation. So this is
   * where retention is paid for, rather than on a timer, on every update, or on
   * a scan nobody triggered. The other half runs once at startup, in
   * `RecoverCameraSourcePromptsUseCase`.
   *
   * Every arm of `prune` is predicated — tombstones past their retention
   * deadline, and non-terminal rows past the abandonment horizon — so this is
   * bounded work over an index, never a full-table walk. It is also the last
   * thing the transition does: a refused sweep is retention that has not
   * happened yet, not an answer the administrator does not get, so the
   * rejection is swallowed exactly as the transition's own is.
   */
  private async sweep(now: Date): Promise<void> {
    try {
      await this.prompts.prune(now);
    } catch {
      // Bindingless, for the same reason: a better-sqlite3 rejection can quote
      // the rows it refused, and one of them is a credential prompt's row.
    }
  }

  /** Mints the durable row, then remembers only how to route its reply. */
  private async rememberPrompt(
    ctx: TelegramContext,
    receipt: WorkflowReturnReceipt,
    promptMessageId: number,
    phase: CameraSourcePromptPhase,
    page: number,
    selection: CameraSourceSelection,
  ): Promise<void> {
    try {
      await this.prompts.createPending(
        createCameraSourcePrompt(this.newPrompt(receipt, promptMessageId, phase, selection)),
      );
    } catch (error) {
      // Without a durable row the prompt cannot be claimed — and a ForceReply
      // that cannot be claimed is worse than no prompt at all, because
      // `handleText` would hand the answer to the next handler *undeleted*.
      // The shape was already checked before anything was sent, so reaching
      // here means the store refused; the message is therefore retracted.
      //
      // A retraction that fails does **not** leave an unanswerable prompt: the
      // ForceReply is still armed and the administrator can still reply to it.
      // So the routing is kept rather than dropped, and that is what makes the
      // residual safe instead of merely rarer. `handleText` finds no durable
      // row, answers `stale`, and — because the phase is on the state, not the
      // row — still deletes a credential reply and claims the message. The one
      // thing that must never happen here is forgetting the prompt while it is
      // still in the chat.
      if (!(await this.deleteWithRetry(receipt.chatId, promptMessageId))) {
        this.views.set(ctx, { kind: 'prompt', receipt, promptMessageId, phase, page, createdAtMs: this.now() });
      }
      await this.replyFailure(ctx, error);
      return;
    }
    this.views.set(ctx, {
      kind: 'prompt',
      receipt,
      promptMessageId,
      phase,
      page,
      createdAtMs: this.now(),
    });
  }

  /**
   * The row a prompt would be, as the model would build it.
   *
   * Written once so the pre-send check and the real mint validate the *same*
   * object: a guard that constructed its own approximation would drift, and
   * the drift would show up as a ForceReply no row can back.
   */
  private newPrompt(
    receipt: WorkflowReturnReceipt,
    promptMessageId: number,
    phase: CameraSourcePromptPhase,
    selection: CameraSourceSelection,
  ): NewCameraSourcePrompt {
    return {
      userId: receipt.userId,
      chatId: receipt.chatId,
      receiptId: receipt.id,
      promptMessageId,
      phase,
      operation: selection.operation,
      cameraId: selection.cameraId,
      displayName: selection.displayName,
      expectedRevision: selection.expectedRevision,
      createdAt: this.clock.now(),
    };
  }

  /**
   * Whether this prompt could exist, asked **before** anything is sent.
   *
   * This ordering is the fix to a hole, not a tidy-up. `rememberPrompt` used to
   * be the first thing that could refuse a prompt, and by then the ForceReply
   * was already armed in the chat: for a camera whose stored name the durable
   * model rejects, the administrator was shown a generic failure *and* an
   * active "reply with the camera address" prompt. Answering it — the natural
   * thing to do — produced a credential-bearing message that `promptFor` could
   * not match, `handleText` handed back to the next handler, and nothing ever
   * deleted. That is the one outcome this whole workflow exists to prevent.
   *
   * The check is the model itself rather than a restatement of its rules, so a
   * field added to that guard later is covered here without this site having to
   * be remembered. The message identifier is a placeholder: it is the one field
   * that cannot be known before sending, and the real mint validates it.
   *
   * `false` means the administrator has already been answered.
   */
  private async mintable(
    ctx: TelegramContext,
    receipt: WorkflowReturnReceipt,
    phase: CameraSourcePromptPhase,
    selection: CameraSourceSelection,
  ): Promise<boolean> {
    try {
      createCameraSourcePrompt(this.newPrompt(receipt, PROMPT_SHAPE_PROBE_MESSAGE_ID, phase, selection));
      return true;
    } catch (error) {
      await this.replyFailure(ctx, error);
      return false;
    }
  }

  /** One page read, with failures already answered. `null` means answered. */
  private async loadOverview(
    ctx: TelegramContext,
    receipt: WorkflowReturnReceipt,
    page = this.views.rememberedPage(ctx, receipt.id),
  ): Promise<RtspSourcesOverviewPage | null> {
    try {
      return await this.overview.execute({ page, pageSize: SOURCE_PAGE_SIZE });
    } catch (error) {
      await this.replyFailure(ctx, error);
      return null;
    }
  }

  private async showOverview(ctx: TelegramContext, receipt: WorkflowReturnReceipt, page: number): Promise<void> {
    let overview: RtspSourcesOverviewPage;
    try {
      overview = await this.overview.execute({ page, pageSize: SOURCE_PAGE_SIZE });
    } catch (error) {
      await this.replyFailure(ctx, error);
      return;
    }
    await this.renderOverview(ctx, receipt, overview);
  }

  /**
   * Renders one source, read fresh.
   *
   * The selector is resolved against the page it was rendered from rather than
   * against anything remembered, so a source that moved, was renamed or was
   * removed underneath simply is not found — and an unresolved selector reloads
   * the overview instead of acting on a stale row.
   */
  private async showDetail(
    ctx: TelegramContext,
    receipt: WorkflowReturnReceipt,
    selector: string,
    page: number,
  ): Promise<void> {
    const copy = this.copy(ctx);
    const resolved = await this.resolveSelected(ctx, receipt, page, selector);
    if (!resolved) return;
    const { overview, source } = resolved;

    let removesCamera: boolean;
    try {
      removesCamera = await this.removesCamera(source.cameraId);
    } catch (error) {
      await this.replyFailure(ctx, error);
      return;
    }
    this.views.set(ctx, {
      kind: 'detail',
      receipt,
      selector,
      revision: source.revision,
      page: overview.page,
      createdAtMs: this.now(),
    });

    await ctx.reply(detailBody(copy, source), {
      reply_markup: detailKeyboard(copy, this.catalog(ctx).home.common, receipt.id, removesCamera),
    });
  }

  /** The transport/quality/security explanation behind the detail's Details button. */
  private async showDetails(ctx: TelegramContext, receipt: WorkflowReturnReceipt): Promise<void> {
    const state = this.views.current(ctx, receipt.id);
    if (state?.kind !== 'detail') {
      await this.showOverview(ctx, receipt, this.views.rememberedPage(ctx, receipt.id));
      return;
    }
    const copy = this.copy(ctx);
    const resolved = await this.resolveSelected(ctx, receipt, state.page, state.selector);
    if (!resolved) return;
    const { source } = resolved;
    // Details is a screen an administrator reads, so it keeps the detail alive
    // rather than letting the ten-minute window run out underneath them and
    // drop them back to page one of a library they were three pages into.
    this.views.set(ctx, { ...state, revision: source.revision, createdAtMs: this.now() });
    await ctx.reply(detailsBody(copy, source), {
      reply_markup: detailsKeyboard(copy, this.catalog(ctx).home.common, receipt.id, state.selector),
    });
  }

  /*
   * ── The stored-source actions ───────────────────────────────────────────
   *
   * Test, change address and remove all begin the same way and it is not
   * incidental: each re-reads the page its selector was rendered from, so the
   * thing it acts on is the thing that is there, and each takes the revision it
   * needs from that read rather than from what this screen remembers.
   */

  /**
   * Re-probes the stored credential and says what came back.
   *
   * The one action here that is not a mutation, and the use case guarantees
   * that: it re-verifies what is on disk and returns the same projection,
   * leaving revision, `verifiedAt`, policy digest and credential untouched. So
   * nothing is fenced, nothing is consumed, and the workflow does not end — the
   * administrator reads the answer and stays where they were.
   */
  private async runTest(ctx: TelegramContext, receipt: WorkflowReturnReceipt): Promise<void> {
    const opened = await this.openStoredSource(ctx, receipt);
    if (!opened) return;
    const copy = this.copy(ctx);
    await ctx.reply(copy.progress.testing);
    try {
      const tested = await this.testSource.execute({
        actorUserId: receipt.userId,
        cameraId: opened.source.cameraId,
      });
      await this.replyRetaining(() => ctx.reply(this.copy(ctx).outcomes.tested(tested.cameraName)));
    } catch (error) {
      // A test can be re-run unchanged, so `retry` means what it says here —
      // unlike on the paths whose request was a credential that is now deleted.
      await this.replyRecovery(ctx, receipt, error, opened.selector, opened.page, {
        retry: 'test',
        'change-address': 'addr',
        back: `d:${opened.selector}`,
      });
    }
  }

  /**
   * Opens the address half of a replacement.
   *
   * The revision read here is the one the whole replacement is fenced on, and
   * it is written to the durable prompt row rather than kept in memory: the
   * address arrives in a later update — possibly after a restart — and the
   * revision it must be committed against is the one the administrator was
   * shown, not whatever the source has moved to by the time they finish typing.
   *
   * The privacy notice is the same one a first install gets, sent from the page
   * just read, because the administrator is about to hand Telegram exactly the
   * same kind of value.
   */
  private async startReplace(ctx: TelegramContext, receipt: WorkflowReturnReceipt): Promise<void> {
    const opened = await this.openStoredSource(ctx, receipt);
    if (!opened) return;
    await this.sendCredentialPrompt(ctx, receipt, opened.overview, {
      operation: 'replace',
      cameraId: opened.source.cameraId,
      // A stored camera name is validated less strictly than a prompt row
      // accepts, so it is filtered rather than trusted; the row still names the
      // camera by identifier, and the outcome falls back to the boundary's own
      // name. Nothing here depends on it being present.
      displayName: usableDisplayName(opened.source.cameraName),
      expectedRevision: opened.source.revision,
    });
  }

  /**
   * Asks the removal question in whichever of its two readings applies, and
   * arms the answer with the revision this screen was rendered from.
   *
   * The wording is predicted from the camera type — the same fact the Camera
   * boundary decides on — while the *outcome* is read off what the boundary
   * reports it retired. Predicting the question and reporting the answer are
   * different jobs, and only the second one is authoritative.
   */
  private async showRemoval(ctx: TelegramContext, receipt: WorkflowReturnReceipt): Promise<void> {
    const opened = await this.openStoredSource(ctx, receipt);
    if (!opened) return;
    let removesCamera: boolean;
    try {
      removesCamera = await this.removesCamera(opened.source.cameraId);
    } catch (error) {
      await this.replyFailure(ctx, error);
      return;
    }
    const copy = this.copy(ctx);
    await ctx.reply(removalBody(copy, opened.source.cameraName, removesCamera), {
      reply_markup: removalKeyboard(
        copy,
        this.catalog(ctx).home.common,
        receipt.id,
        opened.selector,
        opened.source.revision,
        removesCamera,
      ),
    });
  }

  /**
   * Retires the source, at exactly the revision the confirmation was rendered
   * from — which arrives in the callback rather than being read again here.
   *
   * Reading it again is the mutation this method exists to prevent: it would
   * always match, and the compare-and-swap would confirm nothing. Nothing on
   * this path decrypts, loads or renders a credential; the identifier and the
   * revision are the whole of what removal needs.
   */
  private async confirmRemoval(
    ctx: TelegramContext,
    receipt: WorkflowReturnReceipt,
    selector: string,
    expectedRevision: number,
  ): Promise<void> {
    if (!Number.isSafeInteger(expectedRevision)) return;
    const page = this.views.rememberedPage(ctx, receipt.id);
    const resolved = await this.resolveSelected(ctx, receipt, page, selector);
    if (!resolved) return;
    const { overview, source } = resolved;
    const copy = this.copy(ctx);
    await ctx.reply(copy.progress.removing);
    try {
      const { removed } = await this.removeSource.execute({
        actorUserId: receipt.userId,
        cameraId: source.cameraId,
        expectedRevision,
      });
      const outcome = removed === 'camera'
        ? copy.removal.removedCamera(source.cameraName)
        : copy.removal.removedSource(source.cameraName);
      await this.complete(ctx, receipt, () => ctx.reply(outcome));
    } catch (error) {
      await this.replyRecovery(ctx, receipt, error, selector, overview.page, {
        // The identical request, revision included: a removal that failed for a
        // transient reason is still the same removal.
        retry: removalConfirmAction(selector, expectedRevision),
        // Nothing about an address is wrong when a removal fails, so the
        // control that would re-open the credential prompt is left out.
        'change-address': null,
        back: `d:${selector}`,
      });
    }
  }

  /**
   * Hands the conversation to the feature workflow's own reinstall
   * confirmation — the only answer to a network policy that is no longer the
   * one in force, and deliberately *not* a second mutation path: nothing is
   * installed by opening it, and this screen calls no feature operation.
   */
  private async handoffToReinstall(ctx: TelegramContext, receipt: WorkflowReturnReceipt): Promise<void> {
    if (!this.features) {
      await this.replyRetaining(() => ctx.reply(this.copy(ctx).errors['feature-unavailable']));
      return;
    }
    // Beginning a feature workflow supersedes this receipt, so the screen
    // behind it is forgotten here rather than left pointing at a conversation
    // that has moved on — and any prompt it armed is *ended*, not merely
    // forgotten. This is reachable: `ri` is rendered by a test failure, which
    // consumes nothing, so Change address and then the older Reinstall control
    // is an ordinary sequence.
    await this.retractPrompts(receipt);
    this.views.clear(ctx, receipt.id);
    await this.features.handleRtspReinstallEntry(ctx);
  }

  /**
   * Ends every prompt this workflow still has open, message first.
   *
   * Both halves are load-bearing and they fail in opposite directions.
   * Forgetting the routing while the ForceReply is still in the chat leaves a
   * prompt nothing can claim, and a credential answered into it is handed to
   * the next handler undeleted. Keeping the routing while the workflow has
   * moved on lets a receipt the administrator has left authorise an install
   * they never confirmed.
   *
   * So the message is retracted and the row is made terminal — and the routing
   * is dropped only once the message is provably gone. When Telegram refuses,
   * the prompt is still answerable, so its routing stays: `claimReply` then
   * answers `late`, and the reply is deleted as cleanup without authorising
   * anything.
   */
  private async retractPrompts(receipt: WorkflowReturnReceipt): Promise<void> {
    await this.retractPending(receipt.userId, receipt.chatId, receipt.id);
  }

  /**
   * Ends every prompt an administrator has open here — or only one receipt's —
   * by retracting its message, and it is the **only** supported way to stop a
   * prompt being answerable.
   *
   * This exists because forgetting and ending were two different things, and a
   * prompt reached the first without the second. `CameraSourceViewStore` drops
   * a prompt's routing whenever a newer receipt renders, and `cancelPending`
   * did the same on supersession — in both cases leaving an armed ForceReply in
   * the chat with nothing able to claim a reply to it. `handleText` then found
   * no routing, returned `false`, and the credential-bearing message went to
   * the next handler **undeleted**, while its durable row sat `pending` until
   * prune. That is the same terminal state as the hole T5 and T6 each closed
   * from a different direction; this closes it from the direction of
   * supersession.
   *
   * So this is public and asynchronous on purpose: `CameraHandler` owns every
   * supersession path, and none of them can end a prompt correctly without
   * doing Telegram I/O first.
   *
   * The refused-retraction discipline is the same one `handoffToReinstall`
   * established: the routing is dropped only once the message is provably gone.
   * When Telegram refuses, the state goes back — `claimReply` then answers
   * `late`, and the reply is deleted as cleanup without authorising anything.
   */
  async retractPending(userId: number, chatId: number, receiptId?: string): Promise<void> {
    const stranded = await this.retract(this.views.promptsFor(userId, chatId, receiptId), userId, chatId);
    // Screens go with the workflow — they are expendable, and a superseded one
    // must not be reachable. Then the prompts Telegram would not retract are
    // put back: their messages are still armed in the chat, so their routing
    // has to outlive the workflow that opened them or a credential answered
    // into one reaches the next handler undeleted.
    this.views.cancel(userId, chatId, receiptId);
    for (const state of stranded) this.views.restorePrompt(state);
  }

  /**
   * Ends the prompts of every workflow *except* this one, for this
   * administrator here.
   *
   * Opening Sources on a fresh receipt supersedes whatever was open before, and
   * `CameraSourceViewStore.set` enforces that by evicting the older receipt's
   * states — correctly, because a superseded prompt must never be able to
   * install. But eviction only forgets, and this is what turns it into an
   * ending. It runs before the first render, so the eviction never reaches a
   * prompt whose message is still armed.
   *
   * The exclusion is load-bearing in the other direction: re-entering Sources
   * on the *same* receipt is ordinary navigation, and T6 established that it
   * must leave that receipt's own prompt answerable.
   */
  private async retractSuperseded(
    receipt: WorkflowReturnReceipt,
  ): Promise<readonly CameraSourcePromptView[]> {
    const open = this.views
      .promptsFor(receipt.userId, receipt.chatId)
      .filter((state) => state.receipt.id !== receipt.id);
    return this.retract(open, receipt.userId, receipt.chatId);
  }

  /**
   * Retracts each prompt's message and makes its row terminal, and hands back
   * the ones Telegram would not delete — which are the only prompts that must
   * stay routable, because they are the only ones still in the chat.
   */
  private async retract(
    open: readonly CameraSourcePromptView[],
    userId: number,
    chatId: number,
  ): Promise<readonly CameraSourcePromptView[]> {
    const stranded: CameraSourcePromptView[] = [];
    let minted = false;
    for (const state of open) {
      const deleted = await this.deleteWithRetry(chatId, state.promptMessageId);
      minted = await this.terminalise(
        {
          userId,
          chatId,
          receiptId: state.receipt.id,
          promptMessageId: state.promptMessageId,
        },
        !deleted,
        // Abandoned, not answered: the window closed on it rather than a reply
        // spending it, which is the same shape startup recovery records.
        'expired',
      ) || minted;
      if (deleted) this.views.clearPrompt(userId, chatId, state.promptMessageId);
      else stranded.push(state);
    }
    // Once for the whole batch: retention is the same bounded, predicated work
    // whether this minted one tombstone or five.
    if (minted) await this.sweep(this.clock.now());
    return stranded;
  }

  /**
   * The remembered detail, re-read.
   *
   * `null` means the administrator has already been answered: with the overview
   * when this screen remembers no open detail or the selector no longer names a
   * source, or with a failure notice when the page could not be read. Every
   * stored-source action starts here, which is what keeps all three fenced on a
   * revision that was actually read rather than one carried in memory.
   */
  private async openStoredSource(
    ctx: TelegramContext,
    receipt: WorkflowReturnReceipt,
  ): Promise<{
    overview: RtspSourcesOverviewPage;
    source: RtspSourceOverview;
    selector: string;
    page: number;
  } | null> {
    const state = this.views.current(ctx, receipt.id);
    if (state?.kind !== 'detail') {
      await this.showOverview(ctx, receipt, this.views.rememberedPage(ctx, receipt.id));
      return null;
    }
    const resolved = await this.resolveSelected(ctx, receipt, state.page, state.selector);
    if (!resolved) return null;
    this.views.set(ctx, {
      kind: 'detail',
      receipt,
      selector: state.selector,
      revision: resolved.source.revision,
      page: resolved.overview.page,
      createdAtMs: this.now(),
    });
    return {
      overview: resolved.overview,
      source: resolved.source,
      selector: state.selector,
      page: resolved.overview.page,
    };
  }

  /**
   * A failure on a stored source: presenter copy, plus the controls this screen
   * can actually honour.
   *
   * `targets` is the narrowing, and it is per-call-site because the presenter
   * classifies the *failure* while only the caller knows what it still has: a
   * test can be re-run, a replacement whose address has already been deleted
   * cannot, and no removal was ever about an address.
   *
   * `source-stale` is answered differently from every other kind, and that is
   * the whole point of it: the revision this action carried is spent, so the
   * answer is the current detail, read fresh and re-armed from what is stored.
   * Offering a control that resent the number which just lost would be offering
   * the same failure again.
   */
  private async replyRecovery(
    ctx: TelegramContext,
    receipt: WorkflowReturnReceipt,
    error: unknown,
    selector: string,
    page: number,
    targets: CameraSourceRecoveryTargets,
  ): Promise<void> {
    // Ahead of the presenter, which maps every feature state to one lossy kind.
    if (await this.replyUnavailable(ctx, error)) return;
    const presented = presentCameraSourceError(error);
    const copy = this.copy(ctx);
    if (presented.kind === 'source-stale') {
      await this.replyRetaining(() => ctx.reply(copy.errors['source-stale']));
      await this.showDetail(ctx, receipt, selector, page);
      return;
    }
    await this.replyRetaining(() => ctx.reply(copy.errors[presented.kind], {
      reply_markup: recoveryKeyboard(
        copy,
        this.catalog(ctx).home.common,
        receipt.id,
        presented.actions,
        targets,
      ),
    }));
  }

  /**
   * Re-reads the page a selector was rendered from and resolves it there.
   *
   * `null` means the administrator has already been answered — with a failure
   * notice, or with a reloaded overview when the selector no longer names a
   * source on that page. Every action that acts on one source goes through
   * here, so none of them can act on a row this screen merely remembers.
   */
  private async resolveSelected(
    ctx: TelegramContext,
    receipt: WorkflowReturnReceipt,
    page: number,
    selector: string,
  ): Promise<{ overview: RtspSourcesOverviewPage; source: RtspSourceOverview } | null> {
    let overview: RtspSourcesOverviewPage;
    try {
      overview = await this.overview.execute({ page, pageSize: SOURCE_PAGE_SIZE });
    } catch (error) {
      await this.replyFailure(ctx, error);
      return null;
    }
    const source = overview.sources.find((candidate) => sourceSelector(candidate.cameraId) === selector);
    if (!source) {
      await this.renderOverview(ctx, receipt, overview);
      return null;
    }
    return { overview, source };
  }

  /**
   * Whether removing this source takes its camera with it.
   *
   * Only a camera minted to carry a source disappears with it; a camera that
   * also records keeps everything except its RTSP address. The Camera boundary
   * decides that at removal time, so the label is derived from the same camera
   * type it decides on rather than guessed from the source projection.
   */
  private async removesCamera(cameraId: string): Promise<boolean> {
    const cameras = await this.cameras.execute();
    return cameras.find((camera) => camera.id === cameraId)?.type === RTSP_SOURCE_CAMERA_TYPE;
  }

  /** Re-renders an already-loaded page without asking the Camera boundary twice. */
  private async renderOverview(
    ctx: TelegramContext,
    receipt: WorkflowReturnReceipt,
    overview: RtspSourcesOverviewPage,
  ): Promise<void> {
    this.views.set(ctx, { kind: 'overview', receipt, page: overview.page, createdAtMs: this.now() });
    const copy = this.copy(ctx);
    await ctx.reply(overviewBody(copy, overview), {
      reply_markup: overviewKeyboard(copy, this.catalog(ctx).home.common, receipt.id, overview),
    });
  }

  private async requireAdmin(ctx: TelegramContext): Promise<boolean> {
    if (ctx.localeState?.user.role === 'admin') return true;
    await this.replyRetaining(() => ctx.reply(this.catalog(ctx).common.adminRequired));
    return false;
  }

  /**
   * The feature-state copy for an unavailable RTSP, or null when the failure is
   * not one. Kept ahead of the error presenter deliberately: the presenter maps
   * every one of these to the single lossy `feature-unavailable`, while these
   * messages name the state and what to do about it.
   */
  private unavailableMessage(ctx: TelegramContext, error: unknown): string | null {
    if (error instanceof CameraSourceUnavailableError) {
      const copy = this.copy(ctx);
      return error.reason === 'rtsp-closed' ? copy.rtspClosed : copy.stopFailed;
    }
    if (!(error instanceof FeatureUnavailableError)) return null;
    const feature = this.catalog(ctx).feature;
    const stale = feature.stale;
    const name = feature.names.rtsp;
    return error.state === 'installed-off' ? stale.disabled(name)
      : error.state === 'needs-attention' ? stale.attention(name)
        : error.state === 'installing' ? stale.installing(name) : stale.unavailable(name);
  }

  private async replyUnavailable(ctx: TelegramContext, error: unknown): Promise<boolean> {
    const message = this.unavailableMessage(ctx, error);
    if (message === null) return false;
    await this.replyRetaining(() => ctx.reply(message));
    return true;
  }

  /**
   * Renders a rejection as copy and nothing else. `error.message` is never
   * interpolated: most failures on this screen were produced by a URL that
   * carries the camera password.
   */
  private async replyFailure(ctx: TelegramContext, error: unknown): Promise<void> {
    if (await this.replyUnavailable(ctx, error)) return;
    const presented = presentCameraSourceError(error);
    await this.replyRetaining(() => ctx.reply(this.copy(ctx).errors[presented.kind]));
  }

  private async requireRtsp(ctx: TelegramContext): Promise<boolean> {
    try {
      await this.availability?.requireReady('rtsp');
      return true;
    } catch (error) {
      await this.replyUnavailable(ctx, error);
      return false;
    }
  }

  /**
   * Ends the workflow on a terminal outcome.
   *
   * This is the *only* path that finishes the durable receipt and forgets this
   * screen's remembered page, and both halves of that are deliberate. Compare
   * `replyRetaining`: a failure is not the end of anything, so it does neither.
   */
  private async complete(
    ctx: TelegramContext,
    receipt: WorkflowReturnReceipt,
    deliver: () => Promise<unknown>,
  ): Promise<void> {
    try {
      if (this.navigation) {
        await this.navigation.complete(
          ctx,
          { receipt },
          {
            effectStage: 'pending',
            deliver: async () => {
              await deliver();
            },
            failureNotice: this.catalog(ctx).home.recovery.unavailable,
          },
        );
        return;
      }
      await deliver();
    } finally {
      this.views.clear(ctx, receipt.id);
    }
  }

  /**
   * Answers without ending anything.
   *
   * A failure is a thing the administrator acts on next, so neither the durable
   * receipt nor the remembered page may be discarded to render one. Both halves
   * matter and each is useless without the other: Task 6 attaches Retry /
   * Change address / Reinstall RTSP to exactly these messages, and
   *
   * - a completed receipt makes every one of those buttons inert, because
   *   `handleCallback` gates on `workflows.validateCurrent`, which only accepts
   *   a receipt still `pending` or `executing`;
   * - a cleared view state loses the page and selector `change-address` needs
   *   to re-open a credential prompt for the source the failure was about.
   *
   * So this delivers the message and stops. The receipt still expires on its
   * own TTL, and Home's recovery still reclaims it; nothing here is leaked, it
   * is only left usable for as long as it would have been anyway.
   */
  private async replyRetaining(deliver: () => Promise<unknown>): Promise<void> {
    await deliver();
  }

  private now(): number {
    return this.clock.now().getTime();
  }
  private catalog(ctx: TelegramContext): LocaleCatalog {
    return ctx.localeState?.catalog ?? catalogFor('en');
  }
  private copy(ctx: TelegramContext): CameraSourceCopy {
    return this.catalog(ctx).camera.sources;
  }
}

/**
 * Whether a display name may be used, mirroring both boundaries it has to
 * cross: the prompt model's own non-secret text guard (which the durable row is
 * asserted against) and `CreateRtspCameraUseCase`'s `displayName`. Deliberately
 * restated rather than imported — neither predicate is exported, and a name
 * that passed here and was refused there would reach the administrator as an
 * opaque `RangeError` instead of copy they can act on.
 *
 * `null` means unusable. The rejected value is never echoed back.
 */
function usableDisplayName(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_DISPLAY_NAME_LENGTH) return null;
  if (NAME_SECRET_SHAPE.test(trimmed)) return null;
  for (let index = 0; index < trimmed.length; index += 1) {
    const code = trimmed.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return null;
  }
  return trimmed;
}

function identityOf(prompt: CameraSourcePrompt): CameraSourcePromptIdentity {
  return {
    userId: prompt.userId,
    chatId: prompt.chatId,
    receiptId: prompt.receiptId,
    promptMessageId: prompt.promptMessageId,
  };
}

/**
 * The camera context a deletion warning names. A credential prompt always
 * carries one of the two — the model refuses a credential prompt that carries
 * neither — and neither is a secret.
 */
function promptCameraName(prompt: CameraSourcePrompt): string {
  return prompt.displayName ?? '';
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
