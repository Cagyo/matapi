import { Inject, Injectable, Optional } from '@nestjs/common';
import { AttachRtspSourceUseCase } from '../../camera/application/attach-rtsp-source.use-case';
import { CreateRtspCameraUseCase } from '../../camera/application/create-rtsp-camera.use-case';
import {
  GetRtspSourceOverviewUseCase,
  type RtspSourceOverview,
  type RtspSourcesOverviewPage,
} from '../../camera/application/get-rtsp-source-overview.use-case';
import { ListCamerasUseCase } from '../../camera/application/list-cameras.use-case';
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
} from '../domain/camera-source-prompt';
import type { WorkflowReturnReceipt } from '../domain/workflow-return';
import { presentCameraSourceError } from './camera-source-error.presenter';
import { CameraSourceViewStore } from './camera-source-view-store';
import {
  addBody,
  addKeyboard,
  attachBody,
  attachKeyboard,
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
  SELECTOR_LENGTH,
  sourceSelector,
  type CameraSourceCopy,
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

/** The non-secret selection a credential prompt is minted around. */
interface CameraSourceSelection {
  operation: CameraSourcePromptOperation;
  cameraId: string | null;
  displayName: string | null;
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
    @Inject(CAMERA_SOURCE_PROMPT_REPOSITORY)
    private readonly prompts: CameraSourcePromptRepositoryPort,
    @Inject(CAMERA_SOURCE_MESSAGE) private readonly messages: CameraSourceMessagePort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    private readonly workflows: WorkflowEntryCoordinator,
    @Optional() private readonly navigation?: WorkflowNavigationHandler,
    @Optional() @Inject(FEATURE_AVAILABILITY) private readonly availability?: FeatureAvailabilityPort,
  ) {}

  cancelPending(userId: number, chatId: number, receiptId?: string): void {
    this.views.cancel(userId, chatId, receiptId);
  }

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
    this.views.clear(ctx, receipt.id);
    await this.showOverview(ctx, receipt, 1);
  }

  async handleCallback(ctx: TelegramContext, action: string, receipt: WorkflowReturnReceipt): Promise<void> {
    if (!(await this.workflows.validateCurrent(ctx, receipt))) return;
    if (!(await this.requireAdmin(ctx))) return;
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
    // `test`, `addr` (change address) and `rm` (remove) are rendered by the
    // Sources screen and executed by Task 6. They are inert on purpose: an
    // action that mutates a *stored* source belongs with the revision fencing
    // that arrives with it, not with the screen that offers it.
    //
    // None of them reuses a letter from the operation picker this screen
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

    // The exact prompt is spent the moment it is answered, however that goes:
    // the durable row decides what happens next, and a second reply to the same
    // message must not find a live screen behind it.
    this.views.clear(ctx, state.receipt.id);
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
        await this.finishPrompt(claim.prompt, !deleted);
        return true;
      }
      await this.runCredentialReply(ctx, state.receipt, claim.prompt, replyMessageId, state.page);
      return true;
    }
    // A name reply that lost the claim changes nothing and reveals nothing.
    if (claim.kind === 'claimed') {
      await this.runNameReply(ctx, state.receipt, claim.prompt, message.text, state.page);
    }
    return true;
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
      displayName: candidate.cameraName,
    });
  }

  /** The display-name half of a create, as an exact ForceReply. */
  private async sendNamePrompt(
    ctx: TelegramContext,
    receipt: WorkflowReturnReceipt,
    page: number,
  ): Promise<void> {
    const copy = this.copy(ctx);
    const sent = await ctx.reply(namePromptBody(copy), { reply_markup: forceReply() });
    await this.rememberPrompt(ctx, receipt, sent.message_id, 'name', page, {
      operation: 'create',
      cameraId: null,
      displayName: null,
    });
  }

  /**
   * The privacy notice, then the address prompt — in that order, always.
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
    const copy = this.copy(ctx);
    await ctx.reply(privacyNoticeBody(copy, overview.policy.networks, PROMPT_TTL_MINUTES));
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
    await this.finishPrompt(prompt, false);
    if (!(await this.requireAdmin(ctx))) return;
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
   * The plaintext never leaves this frame. It is not returned, not stored on a
   * field, not written to the prompt row, not interpolated into copy, and not
   * logged; the only call it is passed to is the Camera use case that has to
   * dial it. That is why there is no `CredentialReplyContext` struct here: a
   * record carrying the plaintext across a return boundary is precisely what
   * "stack-only" forbids.
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
    let installed: RedactedLiveSource | null = null;
    let failure: unknown = null;
    try {
      if (!denied) {
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

    await this.finishPrompt(prompt, !deleted);
    // The prompt was spent when it was claimed, so the screen behind it has to
    // be put back before anything is rendered: an administrator who lands on a
    // failure is still on the page they started from, and `complete` clears
    // this again on the one path that actually ends the workflow.
    this.views.set(ctx, { kind: 'overview', receipt, page, createdAtMs: this.now() });
    if (!deleted) await ctx.reply(this.copy(ctx).credentialDeletionFailed(promptCameraName(prompt)));
    if (denied) {
      await this.replyRetaining(() => ctx.reply(this.catalog(ctx).common.adminRequired));
      return;
    }
    if (failure !== null) {
      await this.replyFailure(ctx, failure);
      return;
    }
    const copy = this.copy(ctx);
    const name = prompt.displayName ?? installed?.cameraName ?? '';
    const outcome = prompt.operation === 'attach'
      ? copy.outcomes.attached(name)
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
    // A stored prompt this conversation cannot execute — a `replace`, or a
    // selection the row lost. Reported as the source having moved, which is the
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
  private async finishPrompt(prompt: CameraSourcePrompt, deletionFailed: boolean): Promise<void> {
    try {
      await this.prompts.consume({
        identity: identityOf(prompt),
        deletionFailed,
        now: this.clock.now(),
      });
    } catch {
      // Bindingless: a better-sqlite3 rejection can quote the row it refused.
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
        createCameraSourcePrompt({
          userId: receipt.userId,
          chatId: receipt.chatId,
          receiptId: receipt.id,
          promptMessageId,
          phase,
          operation: selection.operation,
          cameraId: selection.cameraId,
          displayName: selection.displayName,
          expectedRevision: null,
          createdAt: this.clock.now(),
        }),
      );
    } catch (error) {
      // Without a durable row the prompt cannot be claimed, so it is not left
      // sitting in the chat pretending to work.
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
