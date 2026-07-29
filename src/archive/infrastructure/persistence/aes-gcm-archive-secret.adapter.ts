import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Injectable } from '@nestjs/common';
import type {
  ArchiveSecretCipherPort,
  ArchiveSecretContext,
  ArchiveSecretEnvelope,
} from '../../application/ports/archive-secret-cipher.port';
import { DriveCredentialCorruptError } from '../../domain/errors/drive-credential-corrupt.error';

/** AES-256-GCM adapter bound to an installation, row, and secret purpose. */
@Injectable()
export class AesGcmArchiveSecretAdapter implements ArchiveSecretCipherPort {
  constructor(private readonly keyPath: string) {}

  async encrypt(plaintext: Buffer, context: ArchiveSecretContext): Promise<ArchiveSecretEnvelope> {
    try {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', await this.readKey(), iv);
      cipher.setAAD(associatedData(context));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return {
        version: 1,
        iv: iv.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
        authTag: cipher.getAuthTag().toString('base64'),
      };
    } catch (error) {
      if (error instanceof DriveCredentialCorruptError) throw error;
      throw new DriveCredentialCorruptError();
    }
  }

  async decrypt(envelope: ArchiveSecretEnvelope, context: ArchiveSecretContext): Promise<Buffer> {
    try {
      const iv = decodeBase64(envelope.iv);
      const ciphertext = decodeBase64(envelope.ciphertext);
      const authTag = decodeBase64(envelope.authTag);
      if (envelope.version !== 1 || iv.length !== 12 || authTag.length !== 16) throw new DriveCredentialCorruptError();
      const decipher = createDecipheriv('aes-256-gcm', await this.readKey(), iv);
      decipher.setAAD(associatedData(context));
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch (error) {
      if (error instanceof DriveCredentialCorruptError) throw error;
      throw new DriveCredentialCorruptError();
    }
  }

  private async readKey(): Promise<Buffer> {
    let key: Buffer;
    try {
      key = await readFile(this.keyPath);
    } catch {
      throw new DriveCredentialCorruptError();
    }
    if (key.length !== 32) throw new DriveCredentialCorruptError();
    return key;
  }
}

function associatedData(context: ArchiveSecretContext): Buffer {
  if (!context.installationId
    || !context.rowId
    || (context.kind !== 'oauth-client' && context.kind !== 'oauth-token')
    || !Number.isSafeInteger(context.schemaVersion)
    || context.schemaVersion < 1) {
    throw new DriveCredentialCorruptError();
  }
  return encodeTuple([
    context.installationId,
    context.rowId,
    context.kind,
    String(context.schemaVersion),
  ]);
}

function encodeTuple(values: readonly string[]): Buffer {
  const encoded = values.map((value) => {
    const bytes = Buffer.from(value, 'utf8');
    if (bytes.toString('utf8') !== value || bytes.length > 0xffff_ffff) throw new DriveCredentialCorruptError();
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, bytes]);
  });
  return Buffer.concat(encoded);
}

function decodeBase64(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new DriveCredentialCorruptError();
  return Buffer.from(value, 'base64');
}
