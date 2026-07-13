import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import { LiveSourceCredentialConfigurationError } from '../domain/errors/live-source-credential-configuration.error';
import { LiveSourceCredentialUnavailableError } from '../domain/errors/live-source-credential-unavailable.error';
import type { LiveSourceCredentialPayload } from '../domain/live-source.entity';
import type {
  EncryptedLiveSourceCredential,
  LiveSourceCredentialPort,
} from '../domain/ports/live-source-credential.port';
import { UnavailableLiveSourceCredentialAdapter } from './unavailable-live-source-credential.adapter';

export interface AesGcmLiveSourceCredentialOptions {
  currentKey: string;
  currentVersion: number;
  previousKeys?: Readonly<Record<number, string>>;
}

export function liveSourceCredentialFromEnvironment(
  env: Record<string, string | undefined>,
): LiveSourceCredentialPort {
  const currentKey = env.RTSP_CREDENTIALS_KEY;
  if (!currentKey) return new UnavailableLiveSourceCredentialAdapter();
  const version = Number(env.RTSP_CREDENTIALS_KEY_VERSION ?? '1');
  const previousKeys: Record<number, string> = {};
  const previous = env.RTSP_CREDENTIALS_PREVIOUS_KEYS;
  if (previous) {
    for (const item of previous.split(',')) {
      const separator = item.indexOf(':');
      if (separator < 1) throw new LiveSourceCredentialConfigurationError();
      const keyVersion = Number(item.slice(0, separator));
      const key = item.slice(separator + 1);
      if (!isKeyVersion(keyVersion) || !isHexKey(key)) {
        throw new LiveSourceCredentialConfigurationError();
      }
      previousKeys[keyVersion] = key;
    }
  }
  return new AesGcmLiveSourceCredentialAdapter({
    currentKey,
    currentVersion: version,
    previousKeys,
  });
}

export class AesGcmLiveSourceCredentialAdapter
  implements LiveSourceCredentialPort
{
  readonly #currentVersion: number;
  readonly #keys: ReadonlyMap<number, Buffer>;

  constructor(options: AesGcmLiveSourceCredentialOptions) {
    if (!isKeyVersion(options.currentVersion) || !isHexKey(options.currentKey)) {
      throw new LiveSourceCredentialConfigurationError();
    }
    const keys = new Map<number, Buffer>([
      [options.currentVersion, Buffer.from(options.currentKey, 'hex')],
    ]);
    for (const [rawVersion, key] of Object.entries(options.previousKeys ?? {})) {
      const version = Number(rawVersion);
      if (!isKeyVersion(version) || !isHexKey(key) || keys.has(version)) {
        throw new LiveSourceCredentialConfigurationError();
      }
      keys.set(version, Buffer.from(key, 'hex'));
    }
    this.#currentVersion = options.currentVersion;
    this.#keys = keys;
  }

  currentVersion(): number {
    return this.#currentVersion;
  }

  encrypt(
    cameraId: string,
    payload: LiveSourceCredentialPayload,
  ): EncryptedLiveSourceCredential {
    try {
      const nonce = randomBytes(12);
      const cipher = createCipheriv(
        'aes-256-gcm',
        this.keyFor(this.#currentVersion),
        nonce,
      );
      cipher.setAAD(aad(cameraId, this.#currentVersion));
      const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return {
        ciphertext: ciphertext.toString('base64'),
        nonce: nonce.toString('base64'),
        authTag: cipher.getAuthTag().toString('base64'),
        keyVersion: this.#currentVersion,
      };
    } catch {
      throw new LiveSourceCredentialUnavailableError();
    }
  }

  decrypt(
    cameraId: string,
    encrypted: EncryptedLiveSourceCredential,
  ): LiveSourceCredentialPayload {
    try {
      if (!isKeyVersion(encrypted.keyVersion)) invalid();
      const nonce = strictBase64(encrypted.nonce, 12);
      const tag = strictBase64(encrypted.authTag, 16);
      const ciphertext = strictBase64(encrypted.ciphertext);
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.keyFor(encrypted.keyVersion),
        nonce,
      );
      decipher.setAAD(aad(cameraId, encrypted.keyVersion));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString('utf8');
      const parsed: unknown = JSON.parse(plaintext);
      if (!isCredentialPayload(parsed)) invalid();
      return parsed;
    } catch {
      throw new LiveSourceCredentialUnavailableError();
    }
  }

  private keyFor(version: number): Buffer {
    const key = this.#keys.get(version);
    if (!key) invalid();
    return key;
  }
}

function aad(cameraId: string, version: number): Buffer {
  if (typeof cameraId !== 'string' || cameraId.length === 0) invalid();
  return Buffer.from(`live-source\0${cameraId}\0${version}`, 'utf8');
}

function isKeyVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isHexKey(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/iu.test(value);
}

function strictBase64(value: unknown, expectedBytes?: number): Buffer {
  if (typeof value !== 'string' || value.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    invalid();
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value || (expectedBytes && decoded.length !== expectedBytes)) {
    invalid();
  }
  return decoded;
}

function isCredentialPayload(value: unknown): value is LiveSourceCredentialPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as LiveSourceCredentialPayload).primaryUrl === 'string' &&
    ((value as LiveSourceCredentialPayload).substreamUrl === null ||
      typeof (value as LiveSourceCredentialPayload).substreamUrl === 'string') &&
    Object.keys(value).length === 2
  );
}

function invalid(): never {
  throw new LiveSourceCredentialUnavailableError();
}
