import type {
  CameraSourcePrompt,
  CameraSourcePromptIdentity,
} from '../../domain/camera-source-prompt';

export const CAMERA_SOURCE_PROMPT_REPOSITORY = Symbol('CAMERA_SOURCE_PROMPT_REPOSITORY');

/**
 * Outcome of the single exact-reply gate.
 *
 * - `claimed` — this reply won the one `pending → running` transition.
 * - `late` — the prompt exists but is no longer claimable (already running,
 *   already terminal, or past its deadline). The caller still gets the prompt
 *   because a late credential reply must be deleted, not acted on.
 * - `stale` — nothing is stored under that identity; the reply belongs to no
 *   prompt this repository knows about.
 */
export type CameraSourcePromptClaim =
  | { kind: 'claimed'; prompt: CameraSourcePrompt }
  | { kind: 'late'; prompt: CameraSourcePrompt }
  | { kind: 'stale' };

/**
 * Durable, credential-free prompt state.
 *
 * Every implementation shares one contract table — `describeCameraSourcePromptContract`
 * in `test/telegram/infrastructure/in-memory-camera-source-prompt.repository.test.ts`,
 * which runs it against both adapters:
 *
 * - `createPending` only accepts a freshly minted prompt
 *   (`createCameraSourcePrompt`), and rejects any value the prompt model
 *   refuses — including one carrying a field the model does not publish.
 * - `claimReply` is a compare-and-set on the exact
 *   user/chat/receipt/prompt-message identity. Exactly one caller can move a
 *   prompt out of `pending`, and `now === expiresAt` is already too late.
 * - `consume`/`expire` are terminal and take only an identity: the stored row
 *   is the authority on the prompt's contents, and a caller holding just
 *   callback data must never have to fabricate a prompt to name one. Both are
 *   idempotent — an identity that no longer resolves is a no-op — and neither
 *   the first terminal status nor its retention deadline is overwritten by a
 *   later call. A `name` prompt is deleted outright; a
 *   `credential` prompt becomes a tombstone retained for exactly 24 hours from
 *   its first terminal transition, and only the newest 100 tombstones per
 *   administrator survive.
 * - `listRunning` returns interrupted prompts oldest-deadline first, bounded by
 *   `limit`.
 * - `prune` removes tombstones past their retention deadline, and prompts that
 *   never reached a terminal state — `pending` or `running` — once they are
 *   older than the abandonment window. Nothing is exempt from every arm, so no
 *   row is immortal. Every arm is predicated; none is a full-table sweep.
 *
 * Dates are carried at millisecond precision in every adapter.
 */
export interface CameraSourcePromptRepositoryPort {
  createPending(prompt: CameraSourcePrompt): Promise<void>;
  claimReply(input: {
    userId: number;
    chatId: number;
    receiptId: string;
    promptMessageId: number;
    replyMessageId: number;
    now: Date;
  }): Promise<CameraSourcePromptClaim>;
  consume(input: {
    identity: CameraSourcePromptIdentity;
    /** Sticky: a standing failure is never cleared by a later clean deletion. */
    deletionFailed: boolean;
    now: Date;
  }): Promise<void>;
  expire(input: {
    identity: CameraSourcePromptIdentity;
    deletionFailed: boolean;
    now: Date;
  }): Promise<void>;
  listRunning(limit: number): Promise<readonly CameraSourcePrompt[]>;
  prune(now: Date): Promise<void>;
}
