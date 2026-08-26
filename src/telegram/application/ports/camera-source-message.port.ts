export const CAMERA_SOURCE_MESSAGE = Symbol('CAMERA_SOURCE_MESSAGE');

/**
 * The single way `delete` may refuse.
 *
 * Parameterless on purpose, for the same reason the live-source probe errors
 * are: the message this names is a credential-bearing reply in an operator
 * chat, and Telegram's own rejection text quotes the chat and message it
 * refused. Nothing about the underlying failure — its text, its `cause`, or the
 * identifiers it carried — travels with this error.
 */
export class CameraSourceMessageDeletionError extends Error {
  readonly code = 'CAMERA_SOURCE_MESSAGE_DELETION_FAILED' as const;

  constructor() {
    super('camera source message could not be deleted');
    this.name = 'CameraSourceMessageDeletionError';
  }
}

/**
 * Deletion of one Telegram message, by identity alone.
 *
 * The port takes two integers rather than a prompt because a prompt carries a
 * receipt and a proposed camera name, and none of that has any business
 * reaching a Telegram API call.
 *
 * **This port fails closed**, unlike `LiveStreamMessageCleanupPort`, whose
 * best-effort deletion swallows everything: a caller here is deleting a
 * credential, so it has to learn whether the message is actually gone in order
 * to record that the deletion is still owed. An implementation that cannot
 * delete — including one asked before a bot exists — rejects with
 * `CameraSourceMessageDeletionError`, never resolves.
 */
export interface CameraSourceMessagePort {
  delete(chatId: number, messageId: number): Promise<void>;
}
