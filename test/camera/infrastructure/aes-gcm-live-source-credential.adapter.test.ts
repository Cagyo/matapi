import { describe, expect, it } from 'vitest';
import {
  AesGcmLiveSourceCredentialAdapter,
  liveSourceCredentialFromEnvironment,
} from '../../../src/camera/infrastructure/aes-gcm-live-source-credential.adapter';

const KEY_1 = '11'.repeat(32);
const KEY_2 = '22'.repeat(32);
const payload = {
  primaryUrl: 'rtsp://user:pass@cam.local/private?token=secret',
  substreamUrl: null,
};

describe('AesGcmLiveSourceCredentialAdapter', () => {
  it('rejects duplicate previous-key versions from environment configuration', () => {
    expect(() =>
      liveSourceCredentialFromEnvironment({
        RTSP_CREDENTIALS_KEY: KEY_2,
        RTSP_CREDENTIALS_KEY_VERSION: '3',
        RTSP_CREDENTIALS_PREVIOUS_KEYS: `1:${KEY_1},1:${KEY_2}`,
      }),
    ).toThrowError(/credential configuration is invalid/i);
  });

  it('uses a fresh 12-byte nonce and a 16-byte authentication tag', () => {
    const adapter = new AesGcmLiveSourceCredentialAdapter({
      currentKey: KEY_1,
      currentVersion: 1,
    });

    const first = adapter.encrypt('front_door', payload);
    const second = adapter.encrypt('front_door', payload);

    expect(Buffer.from(first.nonce, 'base64')).toHaveLength(12);
    expect(Buffer.from(first.authTag, 'base64')).toHaveLength(16);
    expect(first.nonce).not.toBe(second.nonce);
    expect(adapter.decrypt('front_door', first)).toEqual(payload);
  });

  it('binds ciphertext to camera identity and key version without leaking plaintext', () => {
    const adapter = new AesGcmLiveSourceCredentialAdapter({
      currentKey: KEY_1,
      currentVersion: 1,
    });
    const encrypted = adapter.encrypt('front_door', payload);

    for (const operation of [
      () => adapter.decrypt('back_door', encrypted),
      () => adapter.decrypt('front_door', { ...encrypted, keyVersion: 2 }),
      () =>
        new AesGcmLiveSourceCredentialAdapter({
          currentKey: KEY_2,
          currentVersion: 1,
        }).decrypt('front_door', encrypted),
    ]) {
      try {
        operation();
        expect.unreachable('expected authenticated decryption failure');
      } catch (error) {
        expect(error).toMatchObject({
          code: 'LIVE_SOURCE_CREDENTIAL_UNAVAILABLE',
          message: 'Live source credential is unavailable',
        });
        expect(JSON.stringify(error)).not.toMatch(/user|pass|private|secret|auth|cipher/i);
        expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
      }
    }
  });

  it.each([
    ['', 1],
    ['ab', 1],
    ['zz'.repeat(32), 1],
    ['ab'.repeat(33), 1],
    [KEY_1, 0],
    [KEY_1, 1.5],
  ])('rejects malformed key/version configuration', (currentKey, currentVersion) => {
    expect(
      () =>
        new AesGcmLiveSourceCredentialAdapter({ currentKey, currentVersion }),
    ).toThrowError(/credential configuration is invalid/i);
  });

  it.each([
    { ciphertext: '***' },
    { nonce: Buffer.alloc(11).toString('base64') },
    { nonce: 'not-base64' },
    { authTag: Buffer.alloc(15).toString('base64') },
    { authTag: Buffer.alloc(16, 9).toString('base64') },
    { keyVersion: Number.NaN },
    { keyVersion: 1.5 },
    { keyVersion: 99 },
  ])('maps malformed encrypted material to one redacted error: %s', (override) => {
    const adapter = new AesGcmLiveSourceCredentialAdapter({
      currentKey: KEY_1,
      currentVersion: 1,
    });
    const encrypted = adapter.encrypt('front_door', payload);
    expect(() => adapter.decrypt('front_door', { ...encrypted, ...override }))
      .toThrowError('Live source credential is unavailable');
  });
});
