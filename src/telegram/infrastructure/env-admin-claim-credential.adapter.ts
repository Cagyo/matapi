import { createHash, timingSafeEqual } from 'node:crypto';
import { AdminClaimCredentialPort } from '../domain/ports/admin-claim-credential.port';

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export class EnvAdminClaimCredentialAdapter
  implements AdminClaimCredentialPort
{
  private readonly configuredDigest: Buffer | null;

  constructor(value = process.env.CLAIM_ADMIN_TOKEN) {
    const token = value?.trim();
    this.configuredDigest = token ? digest(token) : null;
  }

  isConfigured(): boolean {
    return this.configuredDigest !== null;
  }

  verify(candidate: string): boolean {
    if (!this.configuredDigest) return false;

    return timingSafeEqual(this.configuredDigest, digest(candidate.trim()));
  }
}
