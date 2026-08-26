import { createHash } from 'node:crypto';
import { InlineKeyboard } from 'grammy';
import type {
  RtspSourceOverview,
  RtspSourcesOverviewPage,
} from '../../camera/application/get-rtsp-source-overview.use-case';
import type { RtspSourcePolicyNetwork } from '../../camera/domain/ports/live-source-policy-evaluator.port';
import type { LocaleCatalog } from '../../locales';
import { workflowReturnCallback } from '../domain/workflow-return';
import type { CameraSourceRecoveryAction } from './camera-source-error.presenter';

/**
 * Everything the RTSP source screens render, and nothing they decide.
 *
 * These are pure functions of copy plus an already-loaded Camera projection:
 * no context, no state, no use case, no clock. That is the whole point of the
 * split — `CameraSourcesHandler` owns authorization, readiness, navigation
 * state and the Camera calls, while a screen's text and keyboard can be
 * checked by calling a function rather than by driving a Telegram update.
 *
 * The rule that keeps it honest: nothing here may take a camera identifier
 * except through `sourceSelector`, and nothing here may take an error.
 */

/**
 * How much of a camera-ID digest a row callback carries.
 *
 * Opaque and short: a selector is the only thing standing between an
 * administrator's keyboard and a camera identifier, and it also has to leave
 * the callback inside Telegram's 64-byte limit.
 */
export const SELECTOR_LENGTH = 12;

/** Telegram's hard ceiling on `callback_data`. */
export const MAX_CALLBACK_BYTES = 64;

export type CameraSourceCopy = LocaleCatalog['camera']['sources'];
/** `home.common` — the Back/Home pair every workflow screen ends with. */
export type WorkflowReturnCopy = LocaleCatalog['home']['common'];

export interface CallbackButton {
  text: string;
  callback_data: string;
}

/** Builds `cam:<receipt>:src:<action>`, refusing anything Telegram would reject. */
export function sourceCallback(receiptId: string, action: string): string {
  const callback = `cam:${receiptId}:src:${action}`;
  if (Buffer.byteLength(callback, 'utf8') > MAX_CALLBACK_BYTES)
    throw new RangeError('Camera source callback data exceeds Telegram limit');
  return callback;
}

/** Opaque, stable, and short enough that a row callback always fits. */
export function sourceSelector(cameraId: string): string {
  return createHash('sha256').update(cameraId).digest('base64url').slice(0, SELECTOR_LENGTH);
}

/**
 * The row every source screen ends with, written once.
 *
 * The asymmetry it encodes is deliberate and was previously restated in each
 * keyboard: the overview is the workflow's own first screen, so its Back leaves
 * Camera through the workflow return; every screen *inside* the overview owns a
 * Back of its own that goes one step up, and takes only Home from here. A new
 * screen therefore cannot silently grow a second workflow Back, or lose Home.
 */
export function returnRow(
  home: WorkflowReturnCopy,
  receiptId: string,
  options: { origin: boolean },
): CallbackButton[] {
  const rows: CallbackButton[] = [];
  if (options.origin) {
    rows.push({ text: home.back, callback_data: workflowReturnCallback(receiptId, 'origin') });
  }
  rows.push({ text: home.home, callback_data: workflowReturnCallback(receiptId, 'home') });
  return rows;
}

/**
 * The reply markup that makes a message an *exact* prompt.
 *
 * `selective` restricts the forced reply to the administrator the prompt names,
 * and the reply Telegram produces carries `reply_to_message.message_id` — which
 * is the only thing that lets the handler bind an answer to one prompt rather
 * than to whoever typed next.
 */
export function forceReply(): { force_reply: true; selective: true } {
  return { force_reply: true, selective: true };
}

export function overviewBody(copy: CameraSourceCopy, overview: RtspSourcesOverviewPage): string {
  const heading = overview.pageCount > 1
    ? `${copy.overview.title}\n${copy.overview.page(overview.page, overview.pageCount)}`
    : copy.overview.title;
  const policy = [
    copy.policy.scope,
    networkLines(copy, overview.policy.networks),
    copy.policy.state[overview.policy.state],
  ].join('\n');
  if (overview.sources.length > 0) return `${heading}\n\n${policy}`;
  return `${heading}\n\n${policy}\n\n${copy.emptyState.title}\n${copy.emptyState.body}`;
}

export function overviewKeyboard(
  copy: CameraSourceCopy,
  home: WorkflowReturnCopy,
  receiptId: string,
  overview: RtspSourcesOverviewPage,
): InlineKeyboard {
  const rows: CallbackButton[][] = overview.sources.map((source) => [
    {
      text: copy.row({
        cameraName: source.cameraName,
        status: copy.statuses[source.operationalState],
      }),
      callback_data: sourceCallback(receiptId, `d:${sourceSelector(source.cameraId)}`),
    },
  ]);
  const pager: CallbackButton[] = [];
  if (overview.page > 1) {
    pager.push({ text: copy.overview.previous, callback_data: sourceCallback(receiptId, `p:${overview.page - 1}`) });
  }
  if (overview.page < overview.pageCount) {
    pager.push({ text: copy.overview.next, callback_data: sourceCallback(receiptId, `p:${overview.page + 1}`) });
  }
  if (pager.length > 0) rows.push(pager);
  rows.push([
    {
      text: overview.sources.length === 0 ? copy.emptyState.addFirst : copy.overview.addCamera,
      callback_data: sourceCallback(receiptId, 'add'),
    },
  ]);
  rows.push(returnRow(home, receiptId, { origin: true }));
  return keyboardOf(rows);
}

export function detailBody(copy: CameraSourceCopy, source: RtspSourceOverview): string {
  const detail = copy.detail({
    cameraName: source.cameraName,
    host: source.summary.host,
    status: copy.statuses[source.operationalState],
    relationship: copy.relationships[source.relationship],
  });
  return source.needsReverification ? `${detail}\n\n${copy.reverificationDue}` : detail;
}

export function detailKeyboard(
  copy: CameraSourceCopy,
  home: WorkflowReturnCopy,
  receiptId: string,
  removesCamera: boolean,
): InlineKeyboard {
  return keyboardOf([
    [
      { text: copy.detailButtons.test, callback_data: sourceCallback(receiptId, 'test') },
      { text: copy.detailButtons.changeAddress, callback_data: sourceCallback(receiptId, 'addr') },
    ],
    [
      { text: copy.detailButtons.details, callback_data: sourceCallback(receiptId, 'info') },
      {
        text: removesCamera ? copy.removal.removeCameraButton : copy.removal.removeSourceButton,
        callback_data: sourceCallback(receiptId, 'rm'),
      },
    ],
    // The screen's own Back returns to the overview it came from; the workflow's
    // Back would leave Camera entirely, which is a different promise and belongs
    // to a different control.
    [
      { text: copy.actions.back, callback_data: sourceCallback(receiptId, 'over') },
      ...returnRow(home, receiptId, { origin: false }),
    ],
  ]);
}

export function detailsBody(copy: CameraSourceCopy, source: RtspSourceOverview): string {
  return [
    copy.details.title,
    copy.details.body({
      security: copy.details.security[source.summary.tlsMode],
      transport: copy.details.transports[source.summary.transport],
      profile: copy.details.profiles[source.summary.profile],
      relationship: copy.relationships[source.relationship],
    }),
  ].join('\n\n');
}

export function detailsKeyboard(
  copy: CameraSourceCopy,
  home: WorkflowReturnCopy,
  receiptId: string,
  selector: string,
): InlineKeyboard {
  return keyboardOf([
    [
      { text: copy.actions.back, callback_data: sourceCallback(receiptId, `d:${selector}`) },
      ...returnRow(home, receiptId, { origin: false }),
    ],
  ]);
}

/**
 * The removal question, in whichever of its two readings applies.
 *
 * `removesCamera` is the caller's prediction, derived from the camera type the
 * Camera boundary itself decides on. It names the *question*; the answer's copy
 * is chosen from what the boundary reports it actually retired, which is why
 * nothing here renders an outcome.
 */
export function removalBody(
  copy: CameraSourceCopy,
  cameraName: string,
  removesCamera: boolean,
): string {
  return removesCamera ? copy.removal.confirmCamera(cameraName) : copy.removal.confirmSource(cameraName);
}

/**
 * The confirmation's controls.
 *
 * The confirm button carries the revision this screen was rendered from, so
 * the compare-and-swap is armed by the screen the administrator actually read
 * rather than by whatever the process happens to remember when they press it.
 * Keeping it in the callback is also what makes the fence visible: a removal
 * that re-read the revision at confirm time would be no fence at all.
 */
export function removalKeyboard(
  copy: CameraSourceCopy,
  home: WorkflowReturnCopy,
  receiptId: string,
  selector: string,
  revision: number,
  removesCamera: boolean,
): InlineKeyboard {
  return keyboardOf([
    [
      {
        text: removesCamera ? copy.removal.removeCameraButton : copy.removal.removeSourceButton,
        callback_data: sourceCallback(receiptId, removalConfirmAction(selector, revision)),
      },
    ],
    [
      { text: copy.removal.keep, callback_data: sourceCallback(receiptId, `d:${selector}`) },
      ...returnRow(home, receiptId, { origin: false }),
    ],
  ]);
}

/** The one action that retires a source, and the only place its shape is written. */
export function removalConfirmAction(selector: string, revision: number): string {
  return `rm:y:${selector}:${revision}`;
}

/** The action a `reinstall-rtsp` control carries. Receipt-bound like every other. */
export const REINSTALL_ACTION = 'ri';

/**
 * Where each recovery control goes, for the screen that is offering it.
 *
 * `null` means this screen cannot honour that action, and the button is left
 * out rather than rendered inert: after a credential reply the address has
 * already been deleted, so there is no identical request left for `retry` to
 * re-run, and a removal cannot be repaired by changing an address.
 * `reinstall-rtsp` has no entry because it never varies — it is the feature
 * workflow's own entry, wherever it is offered from.
 */
export interface CameraSourceRecoveryTargets {
  retry: string | null;
  'change-address': string | null;
  back: string;
}

/**
 * A failure's controls: the presenter's answer for that failure kind, narrowed
 * to what this screen can actually do, and then Home.
 *
 * It takes a list of action names rather than an error, exactly like every
 * other function here — classification happened at `presentCameraSourceError`,
 * and nothing on this side of that boundary may see a rejection.
 */
export function recoveryKeyboard(
  copy: CameraSourceCopy,
  home: WorkflowReturnCopy,
  receiptId: string,
  actions: readonly CameraSourceRecoveryAction[],
  targets: CameraSourceRecoveryTargets,
): InlineKeyboard {
  const row: CallbackButton[] = [];
  for (const name of actions) {
    const target = name === 'reinstall-rtsp' ? REINSTALL_ACTION : targets[name];
    if (target === null) continue;
    row.push({ text: copy.actions[name], callback_data: sourceCallback(receiptId, target) });
  }
  return keyboardOf([row, returnRow(home, receiptId, { origin: false })]);
}

/** The Add fork, shown only when attaching to an existing camera is possible. */
export function addBody(copy: CameraSourceCopy): string {
  return `${copy.add.title}\n\n${copy.add.choose}`;
}

export function addKeyboard(
  copy: CameraSourceCopy,
  home: WorkflowReturnCopy,
  receiptId: string,
): InlineKeyboard {
  return keyboardOf([
    [{ text: copy.add.create, callback_data: sourceCallback(receiptId, 'add:c') }],
    [{ text: copy.add.attach, callback_data: sourceCallback(receiptId, 'add:a') }],
    [
      { text: copy.actions.back, callback_data: sourceCallback(receiptId, 'over') },
      ...returnRow(home, receiptId, { origin: false }),
    ],
  ]);
}

export function attachBody(copy: CameraSourceCopy, page: number, pageCount: number): string {
  if (pageCount <= 1) return copy.add.chooseCamera;
  return `${copy.add.chooseCamera}\n${copy.overview.page(page, pageCount)}`;
}

/**
 * One row per camera that could take a source, and never more than a page of
 * them.
 *
 * Paged for the same reason the overview is, and it is not cosmetic: the
 * candidate list is every enabled non-RTSP camera without a source, which the
 * Camera boundary filters but does not bound. An install with a few dozen
 * Motion cameras would otherwise build a keyboard Telegram rejects outright as
 * too long — turning "attach a source" into an error with no way forward.
 *
 * The identifier reaches the keyboard only through `sourceSelector`, exactly as
 * an overview row does.
 */
export function attachKeyboard(
  copy: CameraSourceCopy,
  home: WorkflowReturnCopy,
  receiptId: string,
  candidates: readonly { cameraId: string; cameraName: string }[],
  page: number,
  pageCount: number,
): InlineKeyboard {
  const rows: CallbackButton[][] = candidates.map((candidate) => [
    {
      text: candidate.cameraName,
      callback_data: sourceCallback(receiptId, `add:s:${sourceSelector(candidate.cameraId)}`),
    },
  ]);
  const pager: CallbackButton[] = [];
  if (page > 1) {
    pager.push({ text: copy.overview.previous, callback_data: sourceCallback(receiptId, `add:a:${page - 1}`) });
  }
  if (page < pageCount) {
    pager.push({ text: copy.overview.next, callback_data: sourceCallback(receiptId, `add:a:${page + 1}`) });
  }
  if (pager.length > 0) rows.push(pager);
  rows.push([
    { text: copy.actions.back, callback_data: sourceCallback(receiptId, 'over') },
    ...returnRow(home, receiptId, { origin: false }),
  ]);
  return keyboardOf(rows);
}

/**
 * The display-name prompt. `replyHint` is repeated on every exact prompt
 * because a ForceReply that is answered with a *new* message is silently
 * ignored, and the administrator has no way to tell that from a broken bot.
 */
export function namePromptBody(copy: CameraSourceCopy): string {
  return [copy.prompts.name, copy.prompts.nameHint, copy.prompts.replyHint].join('\n\n');
}

export function credentialPromptBody(copy: CameraSourceCopy): string {
  return [copy.prompts.credential, copy.prompts.replyHint].join('\n\n');
}

/**
 * What the administrator reads immediately before being asked for an address
 * that may carry a password. The networks are the ones the installed policy
 * describes right now — read fresh for this notice, never remembered — and
 * `minutes` is the prompt window, passed in rather than written twice.
 */
export function privacyNoticeBody(
  copy: CameraSourceCopy,
  networks: readonly RtspSourcePolicyNetwork[],
  minutes: number,
): string {
  return copy.privacyNotice({ networks: networkLines(copy, networks), minutes });
}

/** The installed networks as body text, or the honest admission that there are none. */
function networkLines(
  copy: CameraSourceCopy,
  networks: readonly RtspSourcePolicyNetwork[],
): string {
  if (networks.length === 0) return copy.policy.noNetworks;
  return networks.map((network) => copy.policy.network(network)).join('\n');
}

/**
 * `InlineKeyboard.row()` pushes whatever it is handed, so an empty row would
 * reach Telegram as an empty row. Rows are built as arrays and skipped when
 * empty rather than accumulated with chained `.row()` calls.
 */
function keyboardOf(rows: readonly CallbackButton[][]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const row of rows) if (row.length > 0) keyboard.row(...row);
  return keyboard;
}
