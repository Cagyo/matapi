import { describe, expect, it } from 'vitest';
import { CryptoHomeTokenGenerator } from '../../../src/telegram/infrastructure/crypto-home-token-generator.adapter';

describe('CryptoHomeTokenGenerator', () => {
  it('generates 100 unique URL-safe 16-character tokens', () => {
    const generator = new CryptoHomeTokenGenerator();
    const tokens = Array.from({ length: 100 }, () => generator.generate());

    expect(tokens).toHaveLength(100);
    expect(tokens.every((token) => /^[A-Za-z0-9_-]{16}$/.test(token))).toBe(true);
    expect(new Set(tokens)).toHaveLength(100);
  });
});
