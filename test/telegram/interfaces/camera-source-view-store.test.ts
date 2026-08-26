import { describe, expect, it } from 'vitest';
import type { WorkflowReturnReceipt } from '../../../src/telegram/domain/workflow-return';
import {
  CAMERA_SOURCE_VIEW_TTL_MS,
  CameraSourceViewStore,
} from '../../../src/telegram/interfaces/camera-source-view-store';

/**
 * The ten-minute window, tested by calling functions.
 *
 * Before this store was split out of `CameraSourcesHandler` the only way to
 * reach these branches was to drive whole Telegram conversations through a
 * handler, which is why the boundary itself — the instant a screen stops being
 * live — was never pinned. It is pinned here, on both sides.
 */

const ADMIN = 100;
const CHAT = 42;

function receiptWith(id: string, userId = ADMIN, chatId = CHAT): WorkflowReturnReceipt {
  return {
    id,
    userId,
    chatId,
    kind: 'workflow-return',
    sessionToken: null,
    status: 'pending',
    expiresAt: new Date('2030-01-01'),
    payload: {
      workflow: 'camera',
      phase: 'cancellable',
      originSource: 'captured',
      origin: { kind: 'sensors', page: 1 },
    },
  } satisfies WorkflowReturnReceipt;
}

function contextFor(userId = ADMIN, chatId = CHAT) {
  return { from: { id: userId }, chat: { id: chatId, type: 'private' } } as never;
}

/** A store whose clock the test drives directly. */
function storeAt(start = 0) {
  let now = start;
  const store = new CameraSourceViewStore(() => now);
  return { store, advance: (ms: number) => { now += ms; }, now: () => now };
}

describe('CameraSourceViewStore lifetime', () => {
  const receipt = receiptWith('abcdefghijklmnop');

  it('keeps a screen live for exactly the window, and drops it one millisecond later', () => {
    const { store, advance, now } = storeAt(1_000);
    store.set(contextFor(), { kind: 'overview', receipt, page: 3, createdAtMs: now() });

    advance(CAMERA_SOURCE_VIEW_TTL_MS);
    // The boundary itself: still live *at* the deadline. Asserting only side of
    // it would leave the comparison's direction unmeasured.
    expect(store.current(contextFor(), receipt.id)?.page).toBe(3);
    expect(store.hasPending(ADMIN, CHAT, receipt.id)).toBe(true);

    advance(1);
    expect(store.current(contextFor(), receipt.id)).toBeUndefined();
    expect(store.hasPending(ADMIN, CHAT, receipt.id)).toBe(false);
  });

  it('forgets the remembered page once the window closes, and answers the first page instead', () => {
    const { store, advance, now } = storeAt();
    store.set(contextFor(), { kind: 'overview', receipt, page: 4, createdAtMs: now() });

    expect(store.rememberedPage(contextFor(), receipt.id)).toBe(4);
    advance(CAMERA_SOURCE_VIEW_TTL_MS + 1);
    expect(store.rememberedPage(contextFor(), receipt.id)).toBe(1);
  });

  it('holds a prompt open for exactly the same window', () => {
    const { store, advance, now } = storeAt();
    store.set(contextFor(), {
      kind: 'prompt',
      receipt,
      promptMessageId: 900,
      phase: 'credential',
      page: 2,
      createdAtMs: now(),
    });

    advance(CAMERA_SOURCE_VIEW_TTL_MS);
    expect(store.promptFor(ADMIN, CHAT, 900)?.page).toBe(2);

    advance(1);
    expect(store.promptFor(ADMIN, CHAT, 900)).toBeUndefined();
  });
});

describe('CameraSourceViewStore identity', () => {
  const receipt = receiptWith('abcdefghijklmnop');

  it('matches a prompt only by its own message id', () => {
    const { store, now } = storeAt();
    store.set(contextFor(), {
      kind: 'prompt', receipt, promptMessageId: 900, phase: 'name', page: 1, createdAtMs: now(),
    });

    expect(store.promptFor(ADMIN, CHAT, 900)).toBeDefined();
    expect(store.promptFor(ADMIN, CHAT, 901)).toBeUndefined();
  });

  it('does not hand one administrator the prompt of another', () => {
    const { store, now } = storeAt();
    store.set(contextFor(), {
      kind: 'prompt', receipt, promptMessageId: 900, phase: 'name', page: 1, createdAtMs: now(),
    });

    expect(store.promptFor(ADMIN + 1, CHAT, 900)).toBeUndefined();
    expect(store.promptFor(ADMIN, CHAT + 1, 900)).toBeUndefined();
  });

  it('never matches a screen that is not a prompt', () => {
    const { store, now } = storeAt();
    store.set(contextFor(), { kind: 'overview', receipt, page: 1, createdAtMs: now() });

    expect(store.promptFor(ADMIN, CHAT, 900)).toBeUndefined();
  });

  /*
   * One workflow at a time per chat. A screen opened under a newer receipt
   * evicts the older one, so a reply to a prompt from an abandoned workflow
   * finds nothing rather than resuming it.
   */
  it('evicts an older receipt in the same chat when a newer screen opens', () => {
    const { store, now } = storeAt();
    const older = receiptWith('aaaaaaaaaaaaaaaa');
    const newer = receiptWith('bbbbbbbbbbbbbbbb');
    store.set(contextFor(), {
      kind: 'prompt', receipt: older, promptMessageId: 900, phase: 'name', page: 1, createdAtMs: now(),
    });

    store.set(contextFor(), { kind: 'overview', receipt: newer, page: 1, createdAtMs: now() });

    expect(store.promptFor(ADMIN, CHAT, 900)).toBeUndefined();
    expect(store.hasPending(ADMIN, CHAT, older.id)).toBe(false);
    expect(store.hasPending(ADMIN, CHAT, newer.id)).toBe(true);
  });

  it('keeps the screen of a different administrator when one opens here', () => {
    const { store, now } = storeAt();
    const mine = receiptWith('aaaaaaaaaaaaaaaa');
    const theirs = receiptWith('bbbbbbbbbbbbbbbb', ADMIN + 1, CHAT + 1);
    store.set(contextFor(ADMIN + 1, CHAT + 1), { kind: 'overview', receipt: theirs, page: 1, createdAtMs: now() });

    store.set(contextFor(), { kind: 'overview', receipt: mine, page: 1, createdAtMs: now() });

    expect(store.hasPending(ADMIN + 1, CHAT + 1, theirs.id)).toBe(true);
    expect(store.hasPending(ADMIN, CHAT, mine.id)).toBe(true);
  });
});

describe('CameraSourceViewStore cancellation', () => {
  it('forgets one receipt, or every screen this administrator has here', () => {
    const { store, now } = storeAt();
    const first = receiptWith('aaaaaaaaaaaaaaaa');
    const elsewhere = receiptWith('bbbbbbbbbbbbbbbb', ADMIN, CHAT + 1);
    store.set(contextFor(), { kind: 'overview', receipt: first, page: 1, createdAtMs: now() });
    store.set(contextFor(ADMIN, CHAT + 1), { kind: 'overview', receipt: elsewhere, page: 1, createdAtMs: now() });

    store.cancel(ADMIN, CHAT, first.id);
    expect(store.hasPending(ADMIN, CHAT, first.id)).toBe(false);
    expect(store.hasPending(ADMIN, CHAT + 1, elsewhere.id)).toBe(true);

    store.cancel(ADMIN, CHAT + 1);
    expect(store.hasPending(ADMIN, CHAT + 1, elsewhere.id)).toBe(false);
  });

  it('reports pending without a receipt from the newest screen in the chat', () => {
    const { store, advance, now } = storeAt();
    const receipt = receiptWith('abcdefghijklmnop');
    store.set(contextFor(), { kind: 'overview', receipt, page: 1, createdAtMs: now() });

    expect(store.hasPending(ADMIN, CHAT)).toBe(true);
    advance(CAMERA_SOURCE_VIEW_TTL_MS + 1);
    expect(store.hasPending(ADMIN, CHAT)).toBe(false);
  });
});
