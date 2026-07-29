import { randomBytes, createHash } from 'node:crypto';
import type { ClockPort } from '../../../events/domain/ports/clock.port';
import { DriveConfigurationError } from '../../domain/errors/drive-configuration.error';

const RECEIPT_TTL_MS = 10 * 60 * 1_000;

export interface PendingDriveConnection {
  generationId: string;
  receiptId: string;
  adminUserId: number;
  chatId: number;
  installationId: string;
  createdAtMs: number;
  expiresAtMs: number;
}

/** Creates an opaque, receipt-bound upload invitation without storing a secret. */
export class BeginDriveConnectionUseCase {
  constructor(
    private readonly clock: ClockPort,
    private readonly installationId: string,
    private readonly generateId: () => string = () => randomBytes(12).toString('base64url'),
  ) {}

  execute(input: { adminUserId: number; chatId: number; receiptId?: string }): PendingDriveConnection {
    if (!Number.isSafeInteger(input.adminUserId) || !Number.isSafeInteger(input.chatId) || !this.installationId) {
      throw new DriveConfigurationError('Drive connection binding is invalid');
    }
    const createdAtMs = this.clock.now().getTime();
    const receiptId = input.receiptId ?? this.generateId();
    const generationId = this.generateId();
    if (!isReceipt(receiptId) || !isReceipt(generationId)) throw new DriveConfigurationError('Drive receipt generator is invalid');
    return { generationId, receiptId, adminUserId: input.adminUserId, chatId: input.chatId, installationId: this.installationId, createdAtMs, expiresAtMs: createdAtMs + RECEIPT_TTL_MS };
  }
}

export function hashDriveClientId(clientId: string): string {
  return createHash('sha256').update(clientId, 'utf8').digest('hex');
}

function isReceipt(value: string): boolean {
  return /^[A-Za-z0-9_-]{16}$/.test(value);
}
