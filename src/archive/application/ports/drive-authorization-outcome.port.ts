/**
 * The application-side event emitted by a background device-code poll. It
 * deliberately contains neither client credentials, tokens nor device codes.
 */
export type DriveAuthorizationOutcome =
  | {
    kind: 'authorized';
    generationId: string;
    receiptId: string;
    adminUserId: number;
    chatId: number;
    account: { permissionId: string; email: string | null; displayName: string | null };
  }
  | {
    kind: 'failed';
    generationId: string;
    receiptId: string;
    adminUserId: number;
    chatId: number;
    reason: 'denied' | 'expired' | 'unavailable';
  };

export const DRIVE_AUTHORIZATION_OUTCOME = Symbol('DRIVE_AUTHORIZATION_OUTCOME');

export interface DriveAuthorizationOutcomePort {
  publish(outcome: DriveAuthorizationOutcome): Promise<void>;
}
