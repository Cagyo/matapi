import { randomBytes } from 'node:crypto';
import { HOME_TOKEN_BYTES, HOME_TOKEN_LENGTH } from '../domain/home-callback';
import { HomeTokenGeneratorPort } from '../domain/ports/home-token-generator.port';

export class CryptoHomeTokenGenerator implements HomeTokenGeneratorPort {
  generate(): string {
    const token = randomBytes(HOME_TOKEN_BYTES).toString('base64url');
    if (token.length !== HOME_TOKEN_LENGTH) {
      throw new Error('Generated Home token has an unexpected length');
    }
    return token;
  }
}
