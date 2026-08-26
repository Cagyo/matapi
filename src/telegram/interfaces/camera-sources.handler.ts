import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  GetRtspSourceOverviewUseCase,
  type RtspSourceOverview,
  type RtspSourcesOverviewPage,
} from '../../camera/application/get-rtsp-source-overview.use-case';
import { ListCamerasUseCase } from '../../camera/application/list-cameras.use-case';
import { CameraSourceUnavailableError } from '../../camera/domain/errors/camera-source-unavailable.error';
import { RTSP_SOURCE_CAMERA_TYPE } from '../../camera/domain/ports/rtsp-source-configuration.port';
import { CLOCK, type ClockPort } from '../../events/domain/ports/clock.port';
import { catalogFor, type LocaleCatalog } from '../../locales';
import type { WorkflowReturnReceipt } from '../domain/workflow-return';
import { presentCameraSourceError } from './camera-source-error.presenter';
import {
  detailBody,
  detailKeyboard,
  detailsBody,
  detailsKeyboard,
  overviewBody,
  overviewKeyboard,
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
const SOURCE_STATE_TTL_MS = 10 * 60_000;
const PAGE_ACTION = /^p:([1-9][0-9]{0,15})$/;
// Derived from the presenter's selector width rather than restated, so the two
// cannot drift into a screen that renders selectors its own router rejects.
const DETAIL_ACTION = new RegExp(`^d:([A-Za-z0-9_-]{${SELECTOR_LENGTH}})$`);

/**
 * Everything this screen remembers between two Telegram updates.
 *
 * Navigation only, and nothing that could not be re-derived: a receipt, which
 * page was last rendered, which opaque selector was opened, and the revision
 * that detail was read at. No camera identifier, no display name, no address,
 * no credential — a lost or expired entry costs a reload, never a wrong write.
 */
type CameraSourceViewState =
  | { kind: 'overview'; receipt: WorkflowReturnReceipt; page: number; createdAtMs: number }
  | {
      kind: 'detail';
      receipt: WorkflowReturnReceipt;
      selector: string;
      revision: number;
      page: number;
      createdAtMs: number;
    };

/** Status-first RTSP sources. CameraHandler validates `cam:<receipt>:src*` before delegating here. */
@Injectable()
export class CameraSourcesHandler {
  private readonly states = new Map<string, CameraSourceViewState>();

  constructor(
    private readonly overview: GetRtspSourceOverviewUseCase,
    private readonly cameras: ListCamerasUseCase,
    @Inject(CLOCK) private readonly clock: ClockPort,
    private readonly workflows: WorkflowEntryCoordinator,
    @Optional() private readonly navigation?: WorkflowNavigationHandler,
    @Optional() @Inject(FEATURE_AVAILABILITY) private readonly availability?: FeatureAvailabilityPort,
  ) {}

  cancelPending(userId: number, chatId: number, receiptId?: string): void {
    if (receiptId) {
      this.states.delete(`${userId}:${chatId}:${receiptId}`);
      return;
    }
    for (const key of this.states.keys()) if (key.startsWith(`${userId}:${chatId}:`)) this.states.delete(key);
  }

  hasPending(userId: number, chatId: number, receiptId?: string): boolean {
    const state = receiptId
      ? this.states.get(`${userId}:${chatId}:${receiptId}`)
      : this.statesFor(userId, chatId).at(0);
    if (!state) return false;
    if (this.now() - state.createdAtMs > SOURCE_STATE_TTL_MS) {
      this.states.delete(this.keyFor(state));
      return false;
    }
    return true;
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
    if (!receipt || !(await this.requireAdmin(ctx, receipt))) return;
    if (!(await this.requireRtsp(ctx, receipt))) return;
    this.clear(ctx, receipt.id);
    await this.showOverview(ctx, receipt, 1);
  }

  async handleCallback(ctx: TelegramContext, action: string, receipt: WorkflowReturnReceipt): Promise<void> {
    if (!(await this.workflows.validateCurrent(ctx, receipt))) return;
    if (!(await this.requireAdmin(ctx, receipt))) return;
    if (!(await this.requireRtsp(ctx, receipt))) return;

    const page = PAGE_ACTION.exec(action);
    if (page) return this.showOverview(ctx, receipt, Number(page[1]));
    const detail = DETAIL_ACTION.exec(action);
    if (detail) return this.showDetail(ctx, receipt, detail[1], this.rememberedPage(ctx, receipt.id));
    if (action === 'over') return this.showOverview(ctx, receipt, this.rememberedPage(ctx, receipt.id));
    if (action === 'info') return this.showDetails(ctx, receipt);
    // `add`, `test`, `addr` (change address) and `rm` (remove) are rendered by
    // this task and executed by Tasks 5 and 6. They are inert on purpose: an
    // action that mutates a source belongs with the durable prompt and the
    // revision fencing that arrive with it, not with the screen that offers it.
    //
    // None of them reuses a letter from the operation picker this screen
    // replaced, so a `src:a`/`src:e`/`src:t` button still sitting in an old
    // chat message resolves to nothing rather than to a different operation.
  }

  /**
   * Claims nothing yet.
   *
   * The exact-reply conversations that read text arrive in Task 5 on the
   * durable prompt store; this screen keeps no text prompt of its own, so every
   * message belongs to whoever asked for it. The wiring stays because
   * `CameraHandler` owns the `message:text` registration and Task 5 does not
   * touch that file.
   */
  async handleText(_ctx: TelegramContext): Promise<boolean> {
    return false;
  }

  private async showOverview(ctx: TelegramContext, receipt: WorkflowReturnReceipt, page: number): Promise<void> {
    let overview: RtspSourcesOverviewPage;
    try {
      overview = await this.overview.execute({ page, pageSize: SOURCE_PAGE_SIZE });
    } catch (error) {
      await this.replyFailure(ctx, receipt, error);
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
      await this.replyFailure(ctx, receipt, error);
      return;
    }
    this.set(ctx, {
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
    const state = this.getCurrent(ctx, receipt.id);
    if (state?.kind !== 'detail') {
      await this.showOverview(ctx, receipt, this.rememberedPage(ctx, receipt.id));
      return;
    }
    const copy = this.copy(ctx);
    const resolved = await this.resolveSelected(ctx, receipt, state.page, state.selector);
    if (!resolved) return;
    const { source } = resolved;
    // Details is a screen an administrator reads, so it keeps the detail alive
    // rather than letting the ten-minute window run out underneath them and
    // drop them back to page one of a library they were three pages into.
    this.set(ctx, { ...state, revision: source.revision, createdAtMs: this.now() });
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
      await this.replyFailure(ctx, receipt, error);
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
    this.set(ctx, { kind: 'overview', receipt, page: overview.page, createdAtMs: this.now() });
    const copy = this.copy(ctx);
    await ctx.reply(overviewBody(copy, overview), {
      reply_markup: overviewKeyboard(copy, this.catalog(ctx).home.common, receipt.id, overview),
    });
  }

  private rememberedPage(ctx: TelegramContext, receiptId: string): number {
    return this.getCurrent(ctx, receiptId)?.page ?? 1;
  }

  private async requireAdmin(ctx: TelegramContext, receipt: WorkflowReturnReceipt): Promise<boolean> {
    if (ctx.localeState?.user.role === 'admin') return true;
    this.clear(ctx, receipt.id);
    await this.complete(ctx, receipt, () => ctx.reply(this.catalog(ctx).common.adminRequired));
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

  private async replyUnavailable(ctx: TelegramContext, receipt: WorkflowReturnReceipt, error: unknown): Promise<boolean> {
    const message = this.unavailableMessage(ctx, error);
    if (message === null) return false;
    await this.complete(ctx, receipt, () => ctx.reply(message));
    return true;
  }

  /**
   * Renders a rejection as copy and nothing else. `error.message` is never
   * interpolated: most failures on this screen were produced by a URL that
   * carries the camera password.
   */
  private async replyFailure(ctx: TelegramContext, receipt: WorkflowReturnReceipt, error: unknown): Promise<void> {
    if (await this.replyUnavailable(ctx, receipt, error)) return;
    const presented = presentCameraSourceError(error);
    await this.complete(ctx, receipt, () => ctx.reply(this.copy(ctx).errors[presented.kind]));
  }

  private async requireRtsp(ctx: TelegramContext, receipt: WorkflowReturnReceipt): Promise<boolean> {
    try {
      await this.availability?.requireReady('rtsp');
      return true;
    } catch (error) {
      await this.replyUnavailable(ctx, receipt, error);
      return false;
    }
  }

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
      this.clear(ctx, receipt.id);
    }
  }

  private now(): number {
    return this.clock.now().getTime();
  }
  private set(ctx: TelegramContext, state: CameraSourceViewState): void {
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
  private clear(ctx: TelegramContext, receiptId: string): void {
    this.states.delete(this.key(ctx, receiptId));
  }
  private getCurrent(ctx: TelegramContext, receiptId: string): CameraSourceViewState | undefined {
    const state = this.states.get(this.key(ctx, receiptId));
    if (state && this.now() - state.createdAtMs > SOURCE_STATE_TTL_MS) {
      this.states.delete(this.keyFor(state));
      return undefined;
    }
    return state;
  }
  private statesFor(userId: number, chatId: number): CameraSourceViewState[] {
    return [...this.states.values()]
      .filter((state) => state.receipt.userId === userId && state.receipt.chatId === chatId)
      .sort((left, right) => right.createdAtMs - left.createdAtMs);
  }
  private key(ctx: TelegramContext, receiptId: string): string {
    return `${ctx.from?.id ?? 'none'}:${ctx.chat?.id ?? 'none'}:${receiptId}`;
  }
  private keyFor(state: CameraSourceViewState): string {
    return `${state.receipt.userId}:${state.receipt.chatId}:${state.receipt.id}`;
  }
  private catalog(ctx: TelegramContext): LocaleCatalog {
    return ctx.localeState?.catalog ?? catalogFor('en');
  }
  private copy(ctx: TelegramContext): CameraSourceCopy {
    return this.catalog(ctx).camera.sources;
  }
}
