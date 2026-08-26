import { createHash } from 'node:crypto';
import { InlineKeyboard } from 'grammy';
import type {
  RtspSourceOverview,
  RtspSourcesOverviewPage,
} from '../../camera/application/get-rtsp-source-overview.use-case';
import type { LocaleCatalog } from '../../locales';
import { workflowReturnCallback } from '../domain/workflow-return';

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

export function overviewBody(copy: CameraSourceCopy, overview: RtspSourcesOverviewPage): string {
  const heading = overview.pageCount > 1
    ? `${copy.overview.title}\n${copy.overview.page(overview.page, overview.pageCount)}`
    : copy.overview.title;
  const networks = overview.policy.networks.length > 0
    ? overview.policy.networks.map((network) => copy.policy.network(network))
    : [copy.policy.noNetworks];
  const policy = [copy.policy.scope, ...networks, copy.policy.state[overview.policy.state]].join('\n');
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
  rows.push([
    { text: home.back, callback_data: workflowReturnCallback(receiptId, 'origin') },
    { text: home.home, callback_data: workflowReturnCallback(receiptId, 'home') },
  ]);
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
      { text: home.home, callback_data: workflowReturnCallback(receiptId, 'home') },
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
      { text: home.home, callback_data: workflowReturnCallback(receiptId, 'home') },
    ],
  ]);
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
