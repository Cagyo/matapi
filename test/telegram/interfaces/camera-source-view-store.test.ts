import { describe, expect, it } from 'vitest';
import type { WorkflowReturnReceipt } from '../../../src/telegram/domain/workflow-return';
import {
  CAMERA_SOURCE_PROMPT_ROUTING_TTL_MS,
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

  /*
   * Routing outlives the prompt window, and this is the assertion that says so.
   *
   * It used to say the opposite — that routing died with the screen window, ten
   * minutes — and that was the defect written down as the contract. The durable
   * row answers `late` past its deadline, meaning "delete this reply, authorise
   * nothing", and that answer is only reachable while something still routes
   * the reply to it. With the two windows equal, and the screen test `>` where
   * the durable claim test is `>=`, the whole cleanup path was reachable at
   * exactly one instant: at `expiresAt` it worked, one millisecond later the
   * routing was gone and a credential-bearing reply went to the next handler
   * undeleted.
   */
  function promptAt(store: CameraSourceViewStore, createdAtMs: number): void {
    store.set(contextFor(), {
      kind: 'prompt',
      receipt,
      promptMessageId: 900,
      phase: 'credential',
      page: 2,
      createdAtMs,
    });
  }

  it('keeps a prompt routable well past the window the prompt itself closes in', () => {
    const { store, advance, now } = storeAt();
    promptAt(store, now());

    // The instant the old window died on, and the one that used to be the only
    // one that worked.
    advance(CAMERA_SOURCE_VIEW_TTL_MS);
    expect(store.promptFor(ADMIN, CHAT, 900)?.page).toBe(2);
    advance(1);
    expect(store.promptFor(ADMIN, CHAT, 900)?.page).toBe(2);

    // And an interior point, so the assertion is not pinned to a boundary that
    // a single comparison operator can move.
    advance(60 * 60_000);
    expect(store.promptFor(ADMIN, CHAT, 900)?.page).toBe(2);
  });

  it('stops routing a prompt at the abandonment horizon, so nothing is immortal', () => {
    const { store, advance, now } = storeAt();
    promptAt(store, now());

    advance(CAMERA_SOURCE_PROMPT_ROUTING_TTL_MS);
    expect(store.promptFor(ADMIN, CHAT, 900)?.page).toBe(2);

    advance(1);
    expect(store.promptFor(ADMIN, CHAT, 900)).toBeUndefined();
  });

  /*
   * The tell that found the defect: retraction read one window and routing read
   * another, while the message in the chat obeyed neither. They must agree at
   * every instant, not merely at the ends.
   */
  it.each([
    ['at the prompt window', CAMERA_SOURCE_VIEW_TTL_MS],
    ['just past it', CAMERA_SOURCE_VIEW_TTL_MS + 1],
    ['deep inside the routing horizon', CAMERA_SOURCE_PROMPT_ROUTING_TTL_MS - 1],
    ['past the routing horizon', CAMERA_SOURCE_PROMPT_ROUTING_TTL_MS + 1],
  ])('routes and retracts the same prompts %s', (_label, waited) => {
    const { store, advance, now } = storeAt();
    promptAt(store, now());
    advance(waited);

    expect(store.promptsFor(ADMIN, CHAT).length)
      .toBe(store.promptFor(ADMIN, CHAT, 900) === undefined ? 0 : 1);
    expect(store.promptsFor(ADMIN, CHAT, receipt.id).length)
      .toBe(store.promptFor(ADMIN, CHAT, 900) === undefined ? 0 : 1);
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
   * Routing outlives the screen. A prompt is keyed by the message it forces a
   * reply to, so rendering another screen of the *same* workflow — an overview
   * reloaded by a stale button, a detail re-opened — cannot displace it. When
   * these shared a key, every such render silently orphaned a live credential
   * prompt: the durable row stayed claimable, but nothing looked it up.
   */
  it('keeps a prompt while the same workflow renders other screens', () => {
    const { store, now } = storeAt();
    store.set(contextFor(), {
      kind: 'prompt', receipt, promptMessageId: 900, phase: 'credential', page: 3, createdAtMs: now(),
    });

    store.set(contextFor(), { kind: 'overview', receipt, page: 1, createdAtMs: now() });
    store.set(contextFor(), {
      kind: 'detail', receipt, selector: 'AAAAAAAAAAAA', revision: 4, page: 1, createdAtMs: now(),
    });

    expect(store.promptFor(ADMIN, CHAT, 900)?.page).toBe(3);
  });

  /* `clear` names a receipt's *screen*; the prompt it armed is not one. */
  it('keeps a prompt when the screen behind it is cleared', () => {
    const { store, now } = storeAt();
    store.set(contextFor(), { kind: 'overview', receipt, page: 1, createdAtMs: now() });
    store.set(contextFor(), {
      kind: 'prompt', receipt, promptMessageId: 900, phase: 'credential', page: 1, createdAtMs: now(),
    });

    store.clear(contextFor(), receipt.id);

    expect(store.promptFor(ADMIN, CHAT, 900)).toBeDefined();
    expect(store.hasPending(ADMIN, CHAT, receipt.id)).toBe(false);
  });

  /* Spending a prompt is a different act from replacing a screen. */
  it('forgets exactly the prompt that was spent', () => {
    const { store, now } = storeAt();
    for (const promptMessageId of [900, 901]) {
      store.set(contextFor(), {
        kind: 'prompt', receipt, promptMessageId, phase: 'name', page: 1, createdAtMs: now(),
      });
    }

    store.clearPrompt(ADMIN, CHAT, 900);

    expect(store.promptFor(ADMIN, CHAT, 900)).toBeUndefined();
    expect(store.promptFor(ADMIN, CHAT, 901)).toBeDefined();
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

  /*
   * Cancelling ends a workflow, so it takes the prompts with it — the other
   * half of the rule that a *render* does not. Without this, keying prompts by
   * their message would have quietly made cancellation stop reaching them.
   */
  it('forgets the prompts of the receipt it cancels', () => {
    const { store, now } = storeAt();
    const mine = receiptWith('aaaaaaaaaaaaaaaa');
    const other = receiptWith('bbbbbbbbbbbbbbbb', ADMIN, CHAT + 1);
    store.set(contextFor(), {
      kind: 'prompt', receipt: mine, promptMessageId: 900, phase: 'credential', page: 1, createdAtMs: now(),
    });
    store.set(contextFor(ADMIN, CHAT + 1), {
      kind: 'prompt', receipt: other, promptMessageId: 901, phase: 'credential', page: 1, createdAtMs: now(),
    });

    store.cancel(ADMIN, CHAT, mine.id);

    expect(store.promptFor(ADMIN, CHAT, 900)).toBeUndefined();
    expect(store.promptFor(ADMIN, CHAT + 1, 901)).toBeDefined();
  });

  it('names the messages one receipt still has forcing a reply', () => {
    const { store, now } = storeAt();
    const mine = receiptWith('aaaaaaaaaaaaaaaa');
    store.set(contextFor(), {
      kind: 'prompt', receipt: mine, promptMessageId: 900, phase: 'credential', page: 1, createdAtMs: now(),
    });
    store.set(contextFor(), { kind: 'overview', receipt: mine, page: 1, createdAtMs: now() });

    expect(store.promptMessagesFor(ADMIN, CHAT, mine.id)).toEqual([900]);
    expect(store.promptMessagesFor(ADMIN, CHAT, 'bbbbbbbbbbbbbbbb')).toEqual([]);
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
