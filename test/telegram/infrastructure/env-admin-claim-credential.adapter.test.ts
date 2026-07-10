import { describe, expect, it } from 'vitest';
import { EnvAdminClaimCredentialAdapter } from '../../../src/telegram/infrastructure/env-admin-claim-credential.adapter';

describe('EnvAdminClaimCredentialAdapter', () => {
  it('treats an empty or whitespace-only configured value as unconfigured', () => {
    const credential = new EnvAdminClaimCredentialAdapter(' \t\n ');

    expect(credential.isConfigured()).toBe(false);
    expect(credential.verify('owner-token')).toBe(false);
  });

  it('rejects a wrong candidate', () => {
    const credential = new EnvAdminClaimCredentialAdapter('owner-token');

    expect(credential.verify('wrong-token')).toBe(false);
  });

  it('accepts an exact candidate', () => {
    const credential = new EnvAdminClaimCredentialAdapter('owner-token');

    expect(credential.verify('owner-token')).toBe(true);
  });

  it('normalizes command-separator whitespace around a candidate', () => {
    const credential = new EnvAdminClaimCredentialAdapter('owner-token');

    expect(credential.verify(' \towner-token\n')).toBe(true);
  });
});
