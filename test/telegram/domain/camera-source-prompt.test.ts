import { describe, expect, it } from 'vitest';
import {
  CAMERA_SOURCE_ABANDONED_TTL_MS,
  CAMERA_SOURCE_PROMPT_TTL_MS,
  CAMERA_SOURCE_TOMBSTONE_TTL_MS,
  CAMERA_SOURCE_TOMBSTONES_PER_ADMIN,
  assertCameraSourcePrompt,
  createCameraSourcePrompt,
  isCameraSourcePrompt,
  isCameraSourcePromptLive,
  isTerminalCameraSourcePromptStatus,
  type CameraSourcePrompt,
  type NewCameraSourcePrompt,
} from '../../../src/telegram/domain/camera-source-prompt';

const NOW = new Date('2030-01-01T00:00:00.000Z');
const RECEIPT = '1234567890abcdef';
const SECRET_URL = 'rtsp://operator:hunter2@cam.local/stream1';

function draft(overrides: Partial<NewCameraSourcePrompt> = {}): NewCameraSourcePrompt {
  return {
    userId: 7,
    chatId: 70,
    receiptId: RECEIPT,
    promptMessageId: 90,
    phase: 'credential',
    operation: 'create',
    cameraId: null,
    displayName: 'Front Door',
    expectedRevision: null,
    createdAt: NOW,
    ...overrides,
  };
}

function prompt(overrides: Partial<CameraSourcePrompt> = {}): CameraSourcePrompt {
  return { ...createCameraSourcePrompt(draft()), ...overrides };
}

/** The reason a rejection carries, or `null` when the value was accepted. */
function rejection(value: unknown): string | null {
  try {
    assertCameraSourcePrompt(value);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('camera source prompt retention policy', () => {
  // The global constraints name these numbers outright: prompts expire after
  // exactly ten minutes, credential tombstones are retained for exactly 24
  // hours, and at most 100 are kept per administrator. Every behavioural test
  // computes its expectation *from* these constants, so without a literal pin
  // here any value would be self-consistent and free to drift.
  it('pins the exact windows and cap the spec names', () => {
    expect(CAMERA_SOURCE_PROMPT_TTL_MS).toBe(10 * 60_000);
    expect(CAMERA_SOURCE_TOMBSTONE_TTL_MS).toBe(24 * 60 * 60_000);
    expect(CAMERA_SOURCE_TOMBSTONES_PER_ADMIN).toBe(100);
    expect(CAMERA_SOURCE_ABANDONED_TTL_MS).toBe(24 * 60 * 60_000);
  });
});

describe('createCameraSourcePrompt', () => {
  it('mints a pending prompt that owns its ten-minute window', () => {
    const minted = createCameraSourcePrompt(draft());

    expect(minted.expiresAt.getTime() - NOW.getTime()).toBe(CAMERA_SOURCE_PROMPT_TTL_MS);
    expect(CAMERA_SOURCE_PROMPT_TTL_MS).toBe(10 * 60_000);
    expect(minted).toMatchObject({
      status: 'pending',
      replyMessageId: null,
      deletionFailed: false,
      retainUntil: null,
    });
  });

  it.each([
    ['expiresAt', { expiresAt: new Date(NOW.getTime() + 9 * 60_000) }],
    ['a ten-minute expiresAt', { expiresAt: new Date(NOW.getTime() + CAMERA_SOURCE_PROMPT_TTL_MS) }],
    ['retainUntil', { retainUntil: new Date(NOW.getTime() + 60_000) }],
    ['status', { status: 'running' }],
    ['replyMessageId', { replyMessageId: 91 }],
    ['deletionFailed', { deletionFailed: true }],
  ])('refuses a caller-supplied %s', (_label, overrides) => {
    expect(() => createCameraSourcePrompt({ ...draft(), ...overrides }))
      .toThrow(/owned by the model/);
  });

  it('rejects a creation instant that is not a usable date', () => {
    expect(() => createCameraSourcePrompt(draft({ createdAt: new Date(Number.NaN) })))
      .toThrow(/creation instant/);
    expect(() => createCameraSourcePrompt(draft({ createdAt: NOW.getTime() as unknown as Date })))
      .toThrow(/creation instant/);
  });

  it('applies every persisted invariant to the minted prompt', () => {
    expect(() => createCameraSourcePrompt(draft({ displayName: SECRET_URL }))).toThrow(/display name/);
    expect(() => createCameraSourcePrompt(draft({ receiptId: 'short' }))).toThrow(/receipt/);
  });
});

describe('assertCameraSourcePrompt — identity', () => {
  it('accepts a private chat identified independently of the administrator', () => {
    expect(prompt()).toMatchObject({ userId: 7, chatId: 70 });
    expect(rejection(prompt())).toBeNull();
    expect(isCameraSourcePrompt(prompt())).toBe(true);
  });

  it('accepts a private chat that happens to share the administrator identifier', () => {
    expect(rejection(prompt({ chatId: 7 }))).toBeNull();
  });

  it.each([
    ['a group chat', -1_001_234_567_890],
    ['a channel-shaped chat', -100],
    ['an absent chat', 0],
    ['a fractional chat', 70.5],
    ['a chat that is not a number', '70'],
  ])('rejects %s', (_label, chatId) => {
    expect(rejection(prompt({ chatId: chatId as number }))).toMatch(/group or channel/);
  });

  it.each([
    ['zero', 0],
    ['negative', -7],
    ['fractional', 7.5],
    ['not a number', '7'],
  ])('rejects a %s administrator identifier', (_label, userId) => {
    expect(rejection(prompt({ userId: userId as number }))).toMatch(/administrator/);
  });
});

describe('assertCameraSourcePrompt — receipt and message identities', () => {
  it.each([
    ['too short', '1234567890abcde'],
    ['too long', '1234567890abcdef0'],
    ['out of charset', '1234567890abcde!'],
    ['not a string', 1_234_567_890],
  ])('rejects a %s receipt', (_label, receiptId) => {
    expect(rejection(prompt({ receiptId: receiptId as string }))).toMatch(/receipt/);
  });

  it.each([
    ['zero', 0],
    ['negative', -90],
    ['fractional', 90.5],
    ['not a number', '90'],
  ])('rejects a %s prompt message identifier', (_label, promptMessageId) => {
    expect(rejection(prompt({ promptMessageId: promptMessageId as number })))
      .toMatch(/prompt message/);
  });

  it.each([
    ['zero', 0],
    ['negative', -91],
    ['fractional', 91.5],
    ['not a number', '91'],
  ])('rejects a %s reply message identifier', (_label, replyMessageId) => {
    expect(rejection(prompt({ replyMessageId: replyMessageId as number })))
      .toMatch(/reply message/);
  });

  it('accepts an unanswered prompt with no reply message', () => {
    expect(rejection(prompt({ replyMessageId: null }))).toBeNull();
  });
});

describe('assertCameraSourcePrompt — secret-bearing fields', () => {
  it.each([
    ['an rtsp url', SECRET_URL],
    ['an rtsps url', 'rtsps://cam.local/stream1'],
    ['a schemeless credential', 'operator:hunter2@cam.local'],
    ['a bare scheme', 'RTSP:cam.local'],
    ['an uppercase url', 'RTSP://CAM.LOCAL/STREAM1'],
    ['a control character', 'Front\u0007Door'],
  ])('rejects %s as a display name', (_label, displayName) => {
    expect(rejection(prompt({ displayName }))).toMatch(/display name/);
  });

  it.each([
    ['an rtsp url', SECRET_URL],
    ['a schemeless credential', 'operator:hunter2@cam.local'],
    ['a control character', 'camera\u0007'],
  ])('rejects %s as a camera identifier', (_label, cameraId) => {
    expect(rejection(prompt({ cameraId, displayName: 'Front Door' }))).toMatch(/camera identifier/);
  });

  it('never echoes the rejected value in the reason it reports', () => {
    const reasons = [
      rejection(prompt({ displayName: SECRET_URL })),
      rejection(prompt({ cameraId: SECRET_URL, displayName: null })),
    ];

    for (const reason of reasons) {
      expect(reason).not.toBeNull();
      expect(reason).not.toMatch(/hunter2|operator|cam\.local|rtsp/i);
    }
  });

  it('rejects a field the model does not publish, however it is spelled', () => {
    expect(rejection({ ...prompt(), url: SECRET_URL })).toMatch(/shape/);
    expect(rejection({ ...prompt(), normalizedUrl: SECRET_URL })).toMatch(/shape/);
    expect(isCameraSourcePrompt({ ...prompt(), url: SECRET_URL })).toBe(false);
  });

  it('rejects a display name that is blank or overlong', () => {
    expect(rejection(prompt({ displayName: '   ' }))).toMatch(/display name/);
    expect(rejection(prompt({ displayName: 'x'.repeat(65) }))).toMatch(/display name/);
    expect(rejection(prompt({ displayName: 'x'.repeat(64) }))).toBeNull();
  });
});

describe('assertCameraSourcePrompt — phase, operation and revision', () => {
  it('rejects a credential prompt with no non-secret camera selection or name', () => {
    expect(rejection(prompt({ phase: 'credential', cameraId: null, displayName: null })))
      .toMatch(/camera selection/);
  });

  it.each([
    ['a selected camera', { cameraId: 'camera-1', displayName: null }],
    ['a proposed name', { cameraId: null, displayName: 'Front Door' }],
  ])('accepts a credential prompt carrying %s', (_label, overrides) => {
    expect(rejection(prompt({ phase: 'credential', ...overrides }))).toBeNull();
  });

  it('accepts a name prompt that has not chosen anything yet', () => {
    expect(rejection(prompt({ phase: 'name', cameraId: null, displayName: null }))).toBeNull();
  });

  it.each([
    ['fractional', 1.5],
    ['negative', -1],
    ['not a number', '1'],
    ['not finite', Number.NaN],
  ])('rejects a %s expected revision', (_label, expectedRevision) => {
    expect(rejection(prompt({ expectedRevision: expectedRevision as number })))
      .toMatch(/expected revision/);
  });

  it('accepts a zero expected revision and an absent one', () => {
    expect(rejection(prompt({ expectedRevision: 0 }))).toBeNull();
    expect(rejection(prompt({ expectedRevision: null }))).toBeNull();
  });

  it.each([
    ['phase', { phase: 'address' }, /phase/],
    ['operation', { operation: 'detach' }, /operation/],
    ['status', { status: 'claimed' }, /status/],
  ])('rejects an unknown %s', (_label, overrides, reason) => {
    expect(rejection(prompt(overrides as Partial<CameraSourcePrompt>))).toMatch(reason);
  });

  it('rejects a non-boolean deletion-failure bit', () => {
    expect(rejection(prompt({ deletionFailed: 1 as unknown as boolean }))).toMatch(/deletion/);
  });
});

describe('assertCameraSourcePrompt — retention', () => {
  it('rejects retention on a prompt that is still live', () => {
    expect(rejection(prompt({ status: 'pending', retainUntil: NOW }))).toMatch(/retention/);
    expect(rejection(prompt({ status: 'running', replyMessageId: 91, retainUntil: NOW })))
      .toMatch(/retention/);
  });

  it('requires retention on a terminal credential prompt', () => {
    expect(rejection(prompt({ status: 'consumed', retainUntil: null }))).toMatch(/retention/);
    expect(rejection(prompt({ status: 'expired', retainUntil: null }))).toMatch(/retention/);
    expect(rejection(prompt({ status: 'consumed', retainUntil: NOW }))).toBeNull();
  });

  it.each([
    ['with a retention deadline', NOW],
    ['without one', null],
  ])('refuses a terminal name prompt %s', (_label, retainUntil) => {
    // The table CHECK refuses both shapes. When the domain accepted the second
    // it would have passed in mock mode and thrown an opaque SQLite error in
    // production only, which is the worst possible place to find out.
    expect(rejection(prompt({ phase: 'name', status: 'consumed', retainUntil })))
      .toMatch(/retention/);
    expect(rejection(prompt({ phase: 'name', status: 'expired', retainUntil })))
      .toMatch(/retention/);
  });

  it('rejects an unusable expiry or retention date', () => {
    expect(rejection(prompt({ expiresAt: new Date(Number.NaN) }))).toMatch(/expiry/);
    expect(rejection(prompt({ expiresAt: NOW.getTime() as unknown as Date }))).toMatch(/expiry/);
    expect(rejection(prompt({ status: 'consumed', retainUntil: new Date(Number.NaN) })))
      .toMatch(/retention/);
  });
});

describe('isCameraSourcePromptLive', () => {
  const live = createCameraSourcePrompt(draft());

  it('is live strictly before the deadline', () => {
    expect(isCameraSourcePromptLive(live, new Date(live.expiresAt.getTime() - 1))).toBe(true);
  });

  it('is not live at the deadline itself', () => {
    expect(isCameraSourcePromptLive(live, live.expiresAt)).toBe(false);
    expect(isCameraSourcePromptLive(live, new Date(live.expiresAt.getTime() + 1))).toBe(false);
  });

  it.each(['running', 'consumed', 'expired'] as const)('is not live once %s', (status) => {
    expect(isCameraSourcePromptLive({ ...live, status, replyMessageId: 91, retainUntil: status === 'running' ? null : NOW }, NOW)).toBe(false);
  });
});

describe('isTerminalCameraSourcePromptStatus', () => {
  it('names consumed and expired, and only those', () => {
    expect(isTerminalCameraSourcePromptStatus('consumed')).toBe(true);
    expect(isTerminalCameraSourcePromptStatus('expired')).toBe(true);
    expect(isTerminalCameraSourcePromptStatus('pending')).toBe(false);
    expect(isTerminalCameraSourcePromptStatus('running')).toBe(false);
  });
});
