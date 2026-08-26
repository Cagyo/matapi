import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CameraSourcePromptClaim,
  CameraSourcePromptRepositoryPort,
} from '../../../src/telegram/application/ports/camera-source-prompt-repository.port';
import {
  CAMERA_SOURCE_RECOVERY_LIMIT,
  RecoverCameraSourcePromptsUseCase,
} from '../../../src/telegram/application/recover-camera-source-prompts.use-case';
import {
  CAMERA_SOURCE_TOMBSTONE_TTL_MS,
  assertCameraSourcePrompt,
  createCameraSourcePrompt,
  type CameraSourcePrompt,
  type CameraSourcePromptIdentity,
  type NewCameraSourcePrompt,
} from '../../../src/telegram/domain/camera-source-prompt';
import { InMemoryCameraSourcePromptRepository } from '../../../src/telegram/infrastructure/in-memory-camera-source-prompt.repository';

const NOW = new Date('2030-01-01T00:00:00.000Z');
/** The worker comes back up long after the interrupted prompt's own deadline. */
const RECOVERED_AT = new Date(NOW.getTime() + 30 * 60_000);

const ADMIN = 100;
const CHAT = 907_001;
const RECEIPT = 'aaaaaaaaaaaaaaa1';
const OTHER_RECEIPT = 'aaaaaaaaaaaaaaa2';
const PROMPT_MESSAGE = 90;
const REPLY_MESSAGE = 550_123;
const OTHER_REPLY_MESSAGE = 550_456;
const DISPLAY_NAME = 'Front Door';
/** What grammY hands back — it names the chat and the message it refused. */
const TELEGRAM_TEXT = 'Bad Request: message to delete not found (chat 907001, message 550123)';
/** What better-sqlite3 hands back — it quotes the row it refused. */
const SQLITE_TEXT =
  "SqliteError: CHECK constraint failed: telegram_camera_source_prompts (receipt aaaaaaaaaaaaaaa1)";

/** Collects everything the Nest logger is handed, at every level. */
function captureLogs(): unknown[] {
  const logged: unknown[] = [];
  for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      logged.push(...args);
    });
  }
  return logged;
}

function draft(overrides: Partial<NewCameraSourcePrompt> = {}): NewCameraSourcePrompt {
  return {
    userId: ADMIN,
    chatId: CHAT,
    receiptId: RECEIPT,
    promptMessageId: PROMPT_MESSAGE,
    phase: 'credential',
    operation: 'create',
    cameraId: null,
    displayName: DISPLAY_NAME,
    expectedRevision: null,
    createdAt: NOW,
    ...overrides,
  };
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
 * Drives a prompt to `running` the only way production can: mint it, then win
 * the exact-reply claim. Nothing here reaches around the port.
 */
async function running(
  repository: CameraSourcePromptRepositoryPort,
  overrides: Partial<NewCameraSourcePrompt>,
  replyMessageId: number,
): Promise<CameraSourcePrompt> {
  const prompt = createCameraSourcePrompt(draft(overrides));
  await repository.createPending(prompt);
  const claim = await repository.claimReply({
    ...identityOf(prompt),
    replyMessageId,
    now: new Date(NOW.getTime() + 1_000),
  });
  expect(claim.kind).toBe('claimed');
  return prompt;
}

/**
 * Re-reads a stored row through the port. `late` carries the row itself, so a
 * tombstone is observable without a private hatch; `stale` proves it is gone.
 */
async function reread(
  repository: CameraSourcePromptRepositoryPort,
  prompt: CameraSourcePrompt,
): Promise<CameraSourcePromptClaim> {
  return repository.claimReply({
    ...identityOf(prompt),
    replyMessageId: 999_999,
    now: new Date(RECOVERED_AT.getTime() + 60_000),
  });
}

/**
 * A repository that hands back rows the port cannot currently produce. Used
 * only for the `running` states no public call can reach, so the recovery rule
 * is pinned against what the table can hold rather than what today's writers
 * happen to write.
 */
class FixedRunningPromptRepository implements CameraSourcePromptRepositoryPort {
  readonly expired: { identity: CameraSourcePromptIdentity; deletionFailed: boolean; now: Date }[] = [];
  readonly consumed: unknown[] = [];
  listedLimit: number | null = null;
  prunedAt: Date | null = null;
  /** Prompt message IDs whose terminal transition the store refuses. */
  refuseExpiryFor = new Set<number>();

  constructor(private readonly rows: readonly CameraSourcePrompt[]) {}

  async createPending(): Promise<void> {
    throw new Error('not used by recovery');
  }

  async claimReply(): Promise<CameraSourcePromptClaim> {
    throw new Error('not used by recovery');
  }

  async consume(input: unknown): Promise<void> {
    this.consumed.push(input);
  }

  async expire(input: {
    identity: CameraSourcePromptIdentity;
    deletionFailed: boolean;
    now: Date;
  }): Promise<void> {
    if (this.refuseExpiryFor.has(input.identity.promptMessageId)) throw new Error(SQLITE_TEXT);
    this.expired.push(input);
  }

  async listRunning(limit: number): Promise<readonly CameraSourcePrompt[]> {
    this.listedLimit = limit;
    return this.rows;
  }

  async prune(now: Date): Promise<void> {
    this.prunedAt = now;
  }
}

describe('RecoverCameraSourcePromptsUseCase', () => {
  let repository: InMemoryCameraSourcePromptRepository;
  let messages: { delete: ReturnType<typeof vi.fn> };
  let useCase: RecoverCameraSourcePromptsUseCase;

  beforeEach(() => {
    repository = new InMemoryCameraSourcePromptRepository();
    messages = { delete: vi.fn().mockResolvedValue(undefined) };
    useCase = new RecoverCameraSourcePromptsUseCase(
      repository,
      messages,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('deletes the claimed credential reply and expires the prompt into a 24-hour tombstone', async () => {
    const prompt = await running(repository, {}, REPLY_MESSAGE);

    const outcome = await useCase.execute(RECOVERED_AT);

    expect(outcome).toEqual({ attempted: 1, failed: 0, unfinished: 0 });
    expect(messages.delete.mock.calls).toEqual([[CHAT, REPLY_MESSAGE]]);
    expect(await repository.listRunning(10)).toEqual([]);
    expect(await reread(repository, prompt)).toMatchObject({
      kind: 'late',
      prompt: {
        status: 'expired',
        deletionFailed: false,
        retainUntil: new Date(RECOVERED_AT.getTime() + CAMERA_SOURCE_TOMBSTONE_TTL_MS),
      },
    });
  });

  it('continues after one deletion failure and records only the failure bit', async () => {
    const first = await running(repository, {}, REPLY_MESSAGE);
    const second = await running(
      repository,
      { receiptId: OTHER_RECEIPT, promptMessageId: PROMPT_MESSAGE + 1 },
      OTHER_REPLY_MESSAGE,
    );
    messages.delete.mockRejectedValueOnce(new Error(TELEGRAM_TEXT));

    const outcome = await useCase.execute(RECOVERED_AT);

    expect(outcome).toEqual({ attempted: 2, failed: 1, unfinished: 0 });
    expect(messages.delete.mock.calls).toEqual([
      [CHAT, REPLY_MESSAGE],
      [CHAT, OTHER_REPLY_MESSAGE],
    ]);
    expect(await repository.listRunning(10)).toEqual([]);
    expect(await reread(repository, first)).toMatchObject({
      kind: 'late',
      prompt: { status: 'expired', deletionFailed: true },
    });
    expect(await reread(repository, second)).toMatchObject({
      kind: 'late',
      prompt: { status: 'expired', deletionFailed: false },
    });
  });

  it('terminalises a running name prompt without calling the message adapter', async () => {
    const prompt = await running(
      repository,
      { phase: 'name', displayName: null, cameraId: null },
      REPLY_MESSAGE,
    );

    const outcome = await useCase.execute(RECOVERED_AT);

    expect(outcome).toEqual({ attempted: 0, failed: 0, unfinished: 0 });
    expect(messages.delete).not.toHaveBeenCalled();
    expect(await repository.listRunning(10)).toEqual([]);
    // A name prompt leaves no tombstone; it is removed outright.
    expect(await reread(repository, prompt)).toEqual({ kind: 'stale' });
  });

  it('terminalises a running credential prompt that never recorded a reply', async () => {
    const orphan = assertCameraSourcePrompt({
      ...createCameraSourcePrompt(draft()),
      status: 'running',
    });
    const fixed = new FixedRunningPromptRepository([orphan]);
    const subject = new RecoverCameraSourcePromptsUseCase(
      fixed,
      messages,
    );

    const outcome = await subject.execute(RECOVERED_AT);

    expect(outcome).toEqual({ attempted: 0, failed: 0, unfinished: 0 });
    expect(messages.delete).not.toHaveBeenCalled();
    expect(fixed.expired).toEqual([
      { identity: identityOf(orphan), deletionFailed: false, now: RECOVERED_AT },
    ]);
    expect(fixed.consumed).toEqual([]);
    expect(fixed.listedLimit).toBe(CAMERA_SOURCE_RECOVERY_LIMIT);
    expect(fixed.prunedAt).toBe(RECOVERED_AT);
  });

  it('prunes a tombstone whose retention has run out, after recovering', async () => {
    const settled = await running(repository, {}, REPLY_MESSAGE);
    await repository.expire({ identity: identityOf(settled), deletionFailed: false, now: NOW });
    const interrupted = await running(
      repository,
      { receiptId: OTHER_RECEIPT, promptMessageId: PROMPT_MESSAGE + 1 },
      OTHER_REPLY_MESSAGE,
    );

    const outcome = await useCase.execute(
      new Date(NOW.getTime() + CAMERA_SOURCE_TOMBSTONE_TTL_MS + 1),
    );

    expect(outcome).toEqual({ attempted: 1, failed: 0, unfinished: 0 });
    expect(await reread(repository, settled)).toEqual({ kind: 'stale' });
    expect(await reread(repository, interrupted)).toMatchObject({ kind: 'late' });
  });

  it('keeps a tombstone that is still inside its retention window', async () => {
    const settled = await running(repository, {}, REPLY_MESSAGE);
    await repository.expire({ identity: identityOf(settled), deletionFailed: false, now: NOW });

    await useCase.execute(new Date(NOW.getTime() + CAMERA_SOURCE_TOMBSTONE_TTL_MS - 1));

    expect(await reread(repository, settled)).toMatchObject({ kind: 'late' });
  });

  it('bounds one pass at a hundred rows', () => {
    // Pinned to the literal, not to the constant: an assertion that reads the
    // constant back agrees with any value someone edits it to.
    expect(CAMERA_SOURCE_RECOVERY_LIMIT).toBe(100);
  });

  it('prunes on a healthy boot with nothing to recover', async () => {
    const settled = await running(repository, {}, REPLY_MESSAGE);
    await repository.expire({ identity: identityOf(settled), deletionFailed: false, now: NOW });

    const outcome = await useCase.execute(
      new Date(NOW.getTime() + CAMERA_SOURCE_TOMBSTONE_TTL_MS + 1),
    );

    expect(outcome).toEqual({ attempted: 0, failed: 0, unfinished: 0 });
    expect(messages.delete).not.toHaveBeenCalled();
    expect(await reread(repository, settled)).toEqual({ kind: 'stale' });
  });

  it('carries on when the store refuses to terminalise a row', async () => {
    const refused = assertCameraSourcePrompt({
      ...createCameraSourcePrompt(draft()),
      status: 'running',
      replyMessageId: REPLY_MESSAGE,
    });
    const recovered = assertCameraSourcePrompt({
      ...createCameraSourcePrompt(
        draft({ receiptId: OTHER_RECEIPT, promptMessageId: PROMPT_MESSAGE + 1 }),
      ),
      status: 'running',
      replyMessageId: OTHER_REPLY_MESSAGE,
    });
    const fixed = new FixedRunningPromptRepository([refused, recovered]);
    fixed.refuseExpiryFor.add(refused.promptMessageId);
    const logged = captureLogs();
    const subject = new RecoverCameraSourcePromptsUseCase(fixed, messages);

    const outcome = await subject.execute(RECOVERED_AT);

    expect(outcome).toEqual({ attempted: 2, failed: 0, unfinished: 1 });
    // The row behind the refusal is still deleted, terminalised and swept.
    expect(messages.delete.mock.calls).toEqual([
      [CHAT, REPLY_MESSAGE],
      [CHAT, OTHER_REPLY_MESSAGE],
    ]);
    expect(fixed.expired).toEqual([
      { identity: identityOf(recovered), deletionFailed: false, now: RECOVERED_AT },
    ]);
    expect(fixed.prunedAt).toBe(RECOVERED_AT);
    expect(logged.join('\n')).not.toContain(SQLITE_TEXT);
    expect(logged.join('\n')).not.toContain('CHECK constraint failed');
  });

  it('lets no prompt payload reach the message adapter or the log', async () => {
    const logged = captureLogs();
    await running(repository, {}, REPLY_MESSAGE);
    messages.delete.mockRejectedValueOnce(new Error(TELEGRAM_TEXT));

    await useCase.execute(RECOVERED_AT);

    expect(messages.delete.mock.calls).toEqual([[CHAT, REPLY_MESSAGE]]);
    for (const call of messages.delete.mock.calls) {
      expect(call.every((argument: unknown) => typeof argument === 'number')).toBe(true);
    }
    expect(logged.length).toBeGreaterThan(0);
    const transcript = logged.map((entry) => String(entry)).join('\n');
    for (const secret of [
      TELEGRAM_TEXT,
      'message to delete not found',
      RECEIPT,
      DISPLAY_NAME,
      String(CHAT),
      String(REPLY_MESSAGE),
      String(PROMPT_MESSAGE),
    ]) {
      expect(transcript).not.toContain(secret);
    }
  });
});
