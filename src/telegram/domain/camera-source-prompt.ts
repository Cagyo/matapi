/**
 * Durable state for an exact-reply RTSP prompt (spec 06 / camera sources).
 *
 * A prompt exists so a single ForceReply message can be tied to one
 * administrator, one private chat, one workflow receipt and one prompt message.
 * It deliberately carries **no secret**: the credential-bearing reply is read
 * from the stack and deleted, never stored, so the only fields here are
 * identities, a non-secret camera selection, and lifecycle bookkeeping.
 */

/** Exactly ten minutes. The model owns the window; no caller may widen it. */
export const CAMERA_SOURCE_PROMPT_TTL_MS = 10 * 60_000;

/** How long a terminal credential prompt is retained so a late reply is still cleanable. */
export const CAMERA_SOURCE_TOMBSTONE_TTL_MS = 24 * 60 * 60_000;

/** Newest credential tombstones kept per administrator. */
export const CAMERA_SOURCE_TOMBSTONES_PER_ADMIN = 100;

/**
 * How long a prompt that never reached a terminal state is kept before it is
 * swept. Deliberately a separate constant from the tombstone window even though
 * both start at 24 hours: retention exists so a late reply can still be cleaned
 * up, abandonment exists because Telegram stops letting a bot delete a message
 * after roughly 48 hours, so a deletion still owed on an older row is futile.
 * They are independent policies and must be tunable independently.
 */
export const CAMERA_SOURCE_ABANDONED_TTL_MS = 24 * 60 * 60_000;

/** Same limit `cameras.name` accepts, restated here because domains do not cross. */
const MAX_DISPLAY_NAME_LENGTH = 64;

/** Camera identifiers are opaque (UUID today, YAML-seeded historically). */
const MAX_CAMERA_ID_LENGTH = 128;

const RECEIPT_ID = /^[A-Za-z0-9_-]{16}$/;

/**
 * Shapes a stored value must never take: a URL of any scheme, a bare RTSP(S)
 * scheme, or userinfo. A display name is chosen by a human and a camera
 * identifier is minted by the platform, so neither has a legitimate reason to
 * look like an address or a credential.
 */
const SECRET_SHAPE = /:\/\/|@|rtsps?:/i;

export type CameraSourcePromptPhase = 'name' | 'credential';
export type CameraSourcePromptOperation = 'create' | 'attach' | 'replace';
export type CameraSourcePromptStatus = 'pending' | 'running' | 'consumed' | 'expired';

export interface CameraSourcePrompt {
  userId: number;
  chatId: number;
  receiptId: string;
  promptMessageId: number;
  replyMessageId: number | null;
  phase: CameraSourcePromptPhase;
  operation: CameraSourcePromptOperation;
  cameraId: string | null;
  displayName: string | null;
  expectedRevision: number | null;
  status: CameraSourcePromptStatus;
  deletionFailed: boolean;
  expiresAt: Date;
  retainUntil: Date | null;
}

/**
 * Everything a caller may choose when minting a prompt. `createdAt` — not
 * `expiresAt` — is the only time input, which is what makes the ten-minute
 * window unforgeable: there is no parameter through which a different window
 * could be expressed, and `createCameraSourcePrompt` rejects an object that
 * carries one anyway.
 */
export interface NewCameraSourcePrompt {
  userId: number;
  chatId: number;
  receiptId: string;
  promptMessageId: number;
  phase: CameraSourcePromptPhase;
  operation: CameraSourcePromptOperation;
  cameraId: string | null;
  displayName: string | null;
  expectedRevision: number | null;
  createdAt: Date;
}

/**
 * What uniquely names one prompt. Terminal transitions take this rather than a
 * whole `CameraSourcePrompt`, so a caller holding only callback data never has
 * to fabricate a prompt to satisfy the model — the repository re-reads the
 * stored row, which is the only authority on its contents anyway.
 */
export interface CameraSourcePromptIdentity {
  userId: number;
  chatId: number;
  receiptId: string;
  promptMessageId: number;
}

const PROMPT_KEYS: readonly string[] = [
  'userId', 'chatId', 'receiptId', 'promptMessageId', 'replyMessageId',
  'phase', 'operation', 'cameraId', 'displayName', 'expectedRevision',
  'status', 'deletionFailed', 'expiresAt', 'retainUntil',
];

/** Lifecycle fields the model assigns; a caller supplying one is a bug, not a value. */
const MODEL_OWNED_KEYS: readonly string[] = [
  'replyMessageId', 'status', 'deletionFailed', 'expiresAt', 'retainUntil',
];

/**
 * The only supported way to mint a prompt. The result is always `pending`,
 * unanswered, unretained, and expires exactly `CAMERA_SOURCE_PROMPT_TTL_MS`
 * after `createdAt`.
 */
export function createCameraSourcePrompt(input: NewCameraSourcePrompt): CameraSourcePrompt {
  if (!isRecord(input)) throw new RangeError('camera source prompt is malformed');
  for (const key of MODEL_OWNED_KEYS) {
    if (key in input) {
      throw new RangeError('camera source prompt lifecycle is owned by the model');
    }
  }
  if (!isUsableDate(input.createdAt)) {
    throw new RangeError('camera source prompt creation instant is malformed');
  }
  return assertCameraSourcePrompt({
    userId: input.userId,
    chatId: input.chatId,
    receiptId: input.receiptId,
    promptMessageId: input.promptMessageId,
    replyMessageId: null,
    phase: input.phase,
    operation: input.operation,
    cameraId: input.cameraId,
    displayName: input.displayName,
    expectedRevision: input.expectedRevision,
    status: 'pending',
    deletionFailed: false,
    expiresAt: new Date(input.createdAt.getTime() + CAMERA_SOURCE_PROMPT_TTL_MS),
    retainUntil: null,
  });
}

/**
 * Boundary guard for persisted rows and for anything handed to the repository.
 * Reasons are static strings: a rejection must never echo the value it refused,
 * because the value is exactly what might be a credential.
 */
export function assertCameraSourcePrompt(value: unknown): CameraSourcePrompt {
  const reason = reasonToReject(value);
  if (reason !== null) throw new RangeError(reason);
  return value as CameraSourcePrompt;
}

export function isCameraSourcePrompt(value: unknown): value is CameraSourcePrompt {
  return reasonToReject(value) === null;
}

/** Narrows an arbitrary value to the four fields that name a prompt. */
export function assertCameraSourcePromptIdentity(value: unknown): CameraSourcePromptIdentity {
  if (!isRecord(value)) throw new RangeError('camera source prompt identity is malformed');
  const reason = identityReason(value);
  if (reason !== null) throw new RangeError(reason);
  return {
    userId: value.userId as number,
    chatId: value.chatId as number,
    receiptId: value.receiptId as string,
    promptMessageId: value.promptMessageId as number,
  };
}

/**
 * Guards an exact-reply claim before any row is touched. A reply message of
 * `0` and an unusable `now` are caller bugs, not outcomes: without this they
 * would be swallowed on the paths that never reach the winning branch, and a
 * `NaN` clock would silently read every prompt as late.
 */
export function assertCameraSourcePromptReply(input: {
  userId: number;
  chatId: number;
  receiptId: string;
  promptMessageId: number;
  replyMessageId: number;
  now: Date;
}): CameraSourcePromptIdentity {
  const identity = assertCameraSourcePromptIdentity(input);
  if (!isPositiveInteger(input.replyMessageId)) {
    throw new RangeError('camera source prompt reply message is malformed');
  }
  if (!isUsableDate(input.now)) throw new RangeError('camera source prompt claim instant is malformed');
  return identity;
}

/** Guards a terminal transition before any row is touched. */
export function assertCameraSourcePromptOutcome(input: {
  identity: CameraSourcePromptIdentity;
  deletionFailed: boolean;
  now: Date;
}): CameraSourcePromptIdentity {
  const identity = assertCameraSourcePromptIdentity(input?.identity);
  if (typeof input.deletionFailed !== 'boolean') {
    throw new RangeError('camera source prompt deletion outcome is malformed');
  }
  if (!isUsableDate(input.now)) throw new RangeError('camera source prompt outcome instant is malformed');
  return identity;
}

function isCameraSourcePromptPhase(value: unknown): value is CameraSourcePromptPhase {
  return value === 'name' || value === 'credential';
}

function isCameraSourcePromptOperation(value: unknown): value is CameraSourcePromptOperation {
  return value === 'create' || value === 'attach' || value === 'replace';
}

function isCameraSourcePromptStatus(value: unknown): value is CameraSourcePromptStatus {
  return value === 'pending' || value === 'running' || value === 'consumed' || value === 'expired';
}

/** Terminal prompts are the only ones that may leave a tombstone. */
export function isTerminalCameraSourcePromptStatus(status: CameraSourcePromptStatus): boolean {
  return status === 'consumed' || status === 'expired';
}

/** A prompt is claimable strictly before its deadline; `now === expiresAt` is late. */
export function isCameraSourcePromptLive(prompt: CameraSourcePrompt, now: Date): boolean {
  return prompt.status === 'pending' && now.getTime() < prompt.expiresAt.getTime();
}

/** The four identity fields, validated identically wherever they appear. */
function identityReason(value: Record<string, unknown>): string | null {
  if (!isPositiveInteger(value.userId)) return 'camera source prompt administrator is malformed';
  // Telegram gives groups, supergroups and channels negative identifiers; a
  // prompt only ever lives in a private chat, which the handler boundary
  // confirms with `ctx.chat.type`. The model's job is to refuse the shape.
  if (!isPositiveInteger(value.chatId)) return 'camera source prompt chat must be private, not a group or channel';
  if (typeof value.receiptId !== 'string' || !RECEIPT_ID.test(value.receiptId)) {
    return 'camera source prompt receipt is malformed';
  }
  if (!isPositiveInteger(value.promptMessageId)) return 'camera source prompt message is malformed';
  return null;
}

function reasonToReject(value: unknown): string | null {
  if (!isRecord(value)) return 'camera source prompt is malformed';
  const keys = Object.keys(value);
  if (keys.length !== PROMPT_KEYS.length || !keys.every((key) => PROMPT_KEYS.includes(key))) {
    return 'camera source prompt has an unexpected shape';
  }
  const identity = identityReason(value);
  if (identity !== null) return identity;
  if (value.replyMessageId !== null && !isPositiveInteger(value.replyMessageId)) {
    return 'camera source prompt reply message is malformed';
  }
  if (!isCameraSourcePromptPhase(value.phase)) return 'camera source prompt phase is malformed';
  if (!isCameraSourcePromptOperation(value.operation)) return 'camera source prompt operation is malformed';
  if (value.cameraId !== null && !isNonSecretText(value.cameraId, MAX_CAMERA_ID_LENGTH)) {
    return 'camera source prompt camera identifier is malformed';
  }
  if (value.displayName !== null && !isNonSecretText(value.displayName, MAX_DISPLAY_NAME_LENGTH)) {
    return 'camera source prompt display name is malformed';
  }
  if (value.expectedRevision !== null && !isNonNegativeInteger(value.expectedRevision)) {
    return 'camera source prompt expected revision is malformed';
  }
  if (!isCameraSourcePromptStatus(value.status)) return 'camera source prompt status is malformed';
  if (typeof value.deletionFailed !== 'boolean') {
    return 'camera source prompt deletion outcome is malformed';
  }
  if (!isUsableDate(value.expiresAt)) return 'camera source prompt expiry is malformed';
  if (value.phase === 'credential' && value.cameraId === null && value.displayName === null) {
    return 'camera source prompt requires a camera selection or a proposed name';
  }
  return retentionReason(value);
}

/**
 * A live prompt is never retained; a terminal one is always a credential prompt
 * carrying a retention deadline, because a name prompt is deleted outright and
 * leaves no tombstone to keep.
 *
 * This mirrors `telegram_camera_source_prompts_retention_check` exactly, in
 * both directions. An earlier version accepted a terminal name prompt that the
 * table refused, which would have passed in mock mode and thrown an opaque
 * SQLite error in production only.
 */
function retentionReason(value: Record<string, unknown>): string | null {
  if (!isTerminalCameraSourcePromptStatus(value.status as CameraSourcePromptStatus)) {
    return value.retainUntil === null ? null : 'camera source prompt retention is malformed';
  }
  if (value.phase !== 'credential') {
    return 'camera source prompt retention is not available for a name prompt';
  }
  return isUsableDate(value.retainUntil) ? null : 'camera source prompt retention is malformed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isUsableDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function isNonSecretText(value: unknown, maxLength: number): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return false;
  if (SECRET_SHAPE.test(trimmed)) return false;
  for (let index = 0; index < trimmed.length; index += 1) {
    const code = trimmed.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}
