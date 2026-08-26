import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  CameraSourcePrompt,
  CameraSourcePromptIdentity,
} from '../domain/camera-source-prompt';
import {
  CAMERA_SOURCE_MESSAGE,
  type CameraSourceMessagePort,
} from './ports/camera-source-message.port';
import {
  CAMERA_SOURCE_PROMPT_REPOSITORY,
  type CameraSourcePromptRepositoryPort,
} from './ports/camera-source-prompt-repository.port';

/**
 * How many interrupted prompts one recovery pass takes on. A `running` row is
 * a process that died between claiming a reply and cleaning it up, so in
 * practice there is at most one; the bound exists so a pathological table
 * cannot turn boot into an unbounded sequence of Telegram calls. Row 101
 * simply waits for the next boot.
 *
 * Unrelated to `CAMERA_SOURCE_TOMBSTONES_PER_ADMIN`, which is coincidentally
 * also 100: that is a durable retention cap per administrator, this is a
 * per-boot work bound. They are independent policies, tunable independently.
 */
export const CAMERA_SOURCE_RECOVERY_LIMIT = 100;

export interface CameraSourcePromptRecovery {
  /** Deletions actually sent to Telegram. */
  attempted: number;
  /** How many of those were refused. Each leaves `deletionFailed` standing. */
  failed: number;
  /**
   * Rows the repository refused to terminalise. Counted separately rather than
   * folded into `failed`, which is deletion-scoped: a row can go unfinished
   * without a deletion ever being attempted, and a deletion can be refused on
   * a row that terminalises cleanly. An unfinished row stays `running` and is
   * retried by the next boot.
   */
  unfinished: number;
}

/**
 * Finishes the cleanup an interrupted process could not.
 *
 * A `running` prompt means a credential reply was claimed and the worker died
 * before the message was deleted — so the credential is still sitting in the
 * chat. On boot every such row is taken to a terminal state:
 *
 * - a credential prompt with a claimed reply has that message deleted first;
 * - a name prompt, and a credential prompt with no reply recorded, have nothing
 *   to delete — a name reply holds no secret — but are terminalised all the
 *   same. Leaving one `running` would strand it: recovery would skip it on
 *   every later boot, and only the prune's abandonment backstop would ever
 *   reach it.
 *
 * Recovery is deliberately quiet. A deletion failure becomes exactly one bit —
 * `deletionFailed` — on the tombstone; the adapter's rejection is dropped
 * unread, because it is Telegram's and quotes the chat and message it names.
 */
@Injectable()
export class RecoverCameraSourcePromptsUseCase {
  private readonly logger = new Logger(RecoverCameraSourcePromptsUseCase.name);

  constructor(
    @Inject(CAMERA_SOURCE_PROMPT_REPOSITORY)
    private readonly prompts: CameraSourcePromptRepositoryPort,
    @Inject(CAMERA_SOURCE_MESSAGE)
    private readonly messages: CameraSourceMessagePort,
  ) {}

  async execute(now: Date): Promise<CameraSourcePromptRecovery> {
    const interrupted = await this.prompts.listRunning(CAMERA_SOURCE_RECOVERY_LIMIT);
    let attempted = 0;
    let failed = 0;
    let unfinished = 0;

    for (const prompt of interrupted) {
      // The whole row is isolated, not just its deletion. `docs/error-handling.md`
      // — a batch use case where partial success matters returns counts and
      // never throws mid-batch — and a repository that refuses one row must
      // not abandon the rows behind it, nor the sweep that follows them.
      try {
        const reply = deletableReply(prompt);
        let deletionFailed = false;
        if (reply !== null) {
          attempted += 1;
          deletionFailed = !(await this.deleteQuietly(prompt.chatId, reply));
          if (deletionFailed) failed += 1;
        }
        await this.prompts.expire({ identity: identityOf(prompt), deletionFailed, now });
      } catch {
        // Bindingless on purpose: this rejection is the repository's, and
        // better-sqlite3 error text can quote the row it refused.
        unfinished += 1;
      }
    }

    // One line for the whole pass, and emitted before the sweep so a failing
    // prune cannot swallow the outcome of row work that already succeeded.
    // Counts only: they identify no chat, no message, no administrator.
    if (attempted > 0 || unfinished > 0) {
      this.logger.log(
        `camera source prompt recovery: ${attempted} deletion(s) attempted, `
          + `${failed} refused, ${unfinished} row(s) unfinished`,
      );
    }

    await this.sweep(now);
    return { attempted, failed, unfinished };
  }

  /**
   * Retention's startup half, isolated from the pass that precedes it.
   *
   * The sweep is the last thing boot recovery does and the least urgent: every
   * credential this pass could still remove has already been removed, and the
   * rows this deletes are tombstones and abandoned prompts that hold no secret
   * by construction. A store that refuses it must therefore not turn a boot
   * that *did* finish its cleanup into a rejected one — the caller would see a
   * failure, the counts would be lost, and the row work that succeeded would be
   * reported as if it had not happened.
   *
   * Retention that did not run is retried on the next terminal transition and
   * on the next boot, so nothing here is permanent. The rejection is dropped
   * unread for the usual reason: better-sqlite3 quotes the row it refused.
   */
  private async sweep(now: Date): Promise<void> {
    try {
      await this.prompts.prune(now);
    } catch {
      this.logger.warn('camera source prompt retention sweep was refused');
    }
  }

  /** Isolated so one refused deletion cannot abandon the row's own cleanup. */
  private async deleteQuietly(chatId: number, messageId: number): Promise<boolean> {
    try {
      await this.messages.delete(chatId, messageId);
      return true;
    } catch {
      // Not read, let alone logged: the only thing recovery is allowed to
      // remember about a refusal is that it happened. The count reaches the
      // journal through the single summary line, so a pathological hundred-row
      // failure cannot bury a Pi's journal in content-free warnings.
      return false;
    }
  }
}

/**
 * The message this prompt still owes a deletion for, or `null` when it owes
 * none. A name reply is a camera name the administrator typed, not a secret,
 * and a prompt with no claimed reply has no message to point at.
 */
function deletableReply(prompt: CameraSourcePrompt): number | null {
  return prompt.phase === 'credential' ? prompt.replyMessageId : null;
}

function identityOf(prompt: CameraSourcePrompt): CameraSourcePromptIdentity {
  return {
    userId: prompt.userId,
    chatId: prompt.chatId,
    receiptId: prompt.receiptId,
    promptMessageId: prompt.promptMessageId,
  };
}
