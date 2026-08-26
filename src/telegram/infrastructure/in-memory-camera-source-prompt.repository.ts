import type {
  CameraSourcePromptClaim,
  CameraSourcePromptRepositoryPort,
} from '../application/ports/camera-source-prompt-repository.port';
import {
  CAMERA_SOURCE_ABANDONED_TTL_MS,
  CAMERA_SOURCE_TOMBSTONE_TTL_MS,
  CAMERA_SOURCE_TOMBSTONES_PER_ADMIN,
  assertCameraSourcePrompt,
  assertCameraSourcePromptOutcome,
  assertCameraSourcePromptReply,
  isCameraSourcePromptLive,
  isTerminalCameraSourcePromptStatus,
  type CameraSourcePrompt,
  type CameraSourcePromptIdentity,
  type CameraSourcePromptStatus,
} from '../domain/camera-source-prompt';

function identityOf(identity: CameraSourcePromptIdentity): string {
  return `${identity.userId}:${identity.chatId}:${identity.receiptId}:${identity.promptMessageId}`;
}

function clone(prompt: CameraSourcePrompt): CameraSourcePrompt {
  return {
    ...prompt,
    expiresAt: new Date(prompt.expiresAt),
    retainUntil: prompt.retainUntil === null ? null : new Date(prompt.retainUntil),
  };
}

/**
 * Mock-mode implementation of the same contract as the SQLite adapter, held to
 * it by `describeCameraSourcePromptContract` in
 * `test/telegram/infrastructure/in-memory-camera-source-prompt.repository.test.ts`.
 * A `Map` replaces the immediate transaction; every other rule — the single `pending → running`
 * claim, 24-hour credential tombstones measured from the first terminal
 * transition, the per-administrator retention cap, and the predicated prune —
 * is reproduced exactly.
 */
export class InMemoryCameraSourcePromptRepository implements CameraSourcePromptRepositoryPort {
  private readonly prompts = new Map<string, CameraSourcePrompt>();

  async createPending(prompt: CameraSourcePrompt): Promise<void> {
    const pending = assertCameraSourcePrompt(prompt);
    if (
      pending.status !== 'pending' ||
      pending.replyMessageId !== null ||
      pending.deletionFailed ||
      pending.retainUntil !== null
    ) {
      throw new RangeError('camera source prompt is not newly minted');
    }
    const key = identityOf(pending);
    if (this.prompts.has(key)) throw new RangeError('camera source prompt already exists');
    this.prompts.set(key, clone(pending));
  }

  async claimReply(input: {
    userId: number;
    chatId: number;
    receiptId: string;
    promptMessageId: number;
    replyMessageId: number;
    now: Date;
  }): Promise<CameraSourcePromptClaim> {
    const identity = assertCameraSourcePromptReply(input);
    const stored = this.prompts.get(identityOf(identity));
    if (!stored) return { kind: 'stale' };
    if (!isCameraSourcePromptLive(stored, input.now)) return { kind: 'late', prompt: clone(stored) };

    const claimed = assertCameraSourcePrompt({
      ...clone(stored),
      status: 'running',
      replyMessageId: input.replyMessageId,
    });
    this.prompts.set(identityOf(identity), clone(claimed));
    return { kind: 'claimed', prompt: claimed };
  }

  async consume(input: {
    identity: CameraSourcePromptIdentity;
    deletionFailed: boolean;
    now: Date;
  }): Promise<void> {
    this.finish(input, 'consumed');
  }

  async expire(input: {
    identity: CameraSourcePromptIdentity;
    deletionFailed: boolean;
    now: Date;
  }): Promise<void> {
    this.finish(input, 'expired');
  }

  async listRunning(limit: number): Promise<readonly CameraSourcePrompt[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new RangeError('camera source prompt listing limit is malformed');
    }
    return [...this.prompts.values()]
      .filter((prompt) => prompt.status === 'running')
      .sort((left, right) =>
        left.expiresAt.getTime() - right.expiresAt.getTime()
        || left.userId - right.userId
        || compare(left.receiptId, right.receiptId)
        || left.promptMessageId - right.promptMessageId)
      .slice(0, limit)
      .map(clone);
  }

  async prune(now: Date): Promise<void> {
    if (Number.isNaN(now.getTime())) throw new RangeError('camera source prompt prune instant is malformed');
    const abandonedBefore = now.getTime() - CAMERA_SOURCE_ABANDONED_TTL_MS;
    for (const [key, prompt] of this.prompts) {
      const retained = prompt.retainUntil !== null && prompt.retainUntil.getTime() <= now.getTime();
      // Both non-terminal states are swept once abandoned, so no row is immortal.
      const abandoned = prompt.retainUntil === null
        && (prompt.status === 'pending' || prompt.status === 'running')
        && prompt.expiresAt.getTime() <= abandonedBefore;
      if (retained || abandoned) this.prompts.delete(key);
    }
  }

  private finish(
    input: { identity: CameraSourcePromptIdentity; deletionFailed: boolean; now: Date },
    outcome: Extract<CameraSourcePromptStatus, 'consumed' | 'expired'>,
  ): void {
    const identity = assertCameraSourcePromptOutcome(input);
    const key = identityOf(identity);
    const stored = this.prompts.get(key);
    if (!stored) return;
    if (stored.phase === 'name') {
      this.prompts.delete(key);
      return;
    }
    const settled = isTerminalCameraSourcePromptStatus(stored.status) && stored.retainUntil !== null;
    const status = settled ? stored.status : outcome;
    const retainUntil = settled
      ? new Date(stored.retainUntil!)
      : new Date(input.now.getTime() + CAMERA_SOURCE_TOMBSTONE_TTL_MS);
    const deletionFailed = stored.deletionFailed || input.deletionFailed;
    const tombstone = assertCameraSourcePrompt({ ...clone(stored), status, deletionFailed, retainUntil });
    this.prompts.set(key, clone(tombstone));
    this.trimTombstones(identity.userId);
  }

  private trimTombstones(userId: number): void {
    const tombstones = [...this.prompts.entries()]
      .filter(([, prompt]) => prompt.userId === userId && prompt.retainUntil !== null)
      .sort(([, left], [, right]) =>
        right.retainUntil!.getTime() - left.retainUntil!.getTime()
        || right.promptMessageId - left.promptMessageId
        || compare(right.receiptId, left.receiptId));
    for (const [key] of tombstones.slice(CAMERA_SOURCE_TOMBSTONES_PER_ADMIN)) {
      this.prompts.delete(key);
    }
  }
}

/**
 * SQLite's default `BINARY` collation. Receipt identifiers are ASCII, so this
 * orders them exactly as the SQLite adapter's `ORDER BY` does.
 */
function compare(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
