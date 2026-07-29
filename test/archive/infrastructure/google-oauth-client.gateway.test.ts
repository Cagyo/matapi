import { describe, expect, it, vi } from 'vitest';
import { GoogleOAuthClientGateway, type OAuth2ClientFactory } from '../../../src/archive/infrastructure/google/google-oauth-client.gateway';
import type { DriveCredentialRepositoryPort, OAuthTokenSet } from '../../../src/archive/application/ports/drive-credential-repository.port';
import { DriveReauthorizationRequiredError } from '../../../src/archive/domain/errors/drive-reauthorization-required.error';

class Client {
  private listener: ((tokens: Record<string, unknown>) => void) | undefined;
  credentials: Record<string, unknown> = {};
  fail: unknown = null;

  setCredentials(credentials: Record<string, unknown>): void { this.credentials = credentials; }
  on(_event: 'tokens', listener: (tokens: Record<string, unknown>) => void): this { this.listener = listener; return this; }
  emit(tokens: Record<string, unknown>): void { this.listener?.(tokens); }
  async getAccessToken(): Promise<{ token: string | null }> {
    if (this.fail) throw this.fail;
    return { token: 'refreshed-access' };
  }
}

const tokens = (accessToken: string, refreshToken = 'old-refresh'): OAuthTokenSet => ({ accessToken, refreshToken, expiryDateMs: 1_700_003_600_000, tokenType: 'Bearer', scope: 'https://www.googleapis.com/auth/drive.file' });

describe('GoogleOAuthClientGateway', () => {
  it('merges token events with the captured generation revision and retains a missing refresh token', async () => {
    const client = new Client();
    const repository = repositoryStub();
    const gateway = new GoogleOAuthClientGateway(repository, vi.fn().mockResolvedValue(undefined), { create: () => client } as OAuth2ClientFactory, { now: () => 1_700_000_000_000 });
    const active = gateway.create({ generationId: 'generation-1', revision: 4, client: { clientId: 'id', clientSecret: 'secret' }, tokens: tokens('old-access') });

    client.emit({ access_token: 'new-access', expiry_date: 1_700_007_200_000, token_type: 'Bearer', scope: 'https://www.googleapis.com/auth/drive.file' });
    await active.waitForTokenPersistence();

    expect(repository.mergeRefreshedTokens).toHaveBeenCalledWith(expect.objectContaining({
      generationId: 'generation-1', expectedRevision: 4,
      tokens: expect.objectContaining({ accessToken: 'new-access', refreshToken: 'old-refresh' }),
    }));
  });

  it('fences a late refresh and signals reauthorization only after invalid_grant wins the transition', async () => {
    const client = new Client();
    const repository = repositoryStub();
    repository.mergeRefreshedTokens.mockResolvedValue(false);
    repository.requireReauthorization.mockResolvedValue(true);
    const alert = vi.fn().mockResolvedValue(undefined);
    const gateway = new GoogleOAuthClientGateway(repository, alert, { create: () => client } as OAuth2ClientFactory, { now: () => 1_700_000_000_000 });
    const active = gateway.create({ generationId: 'generation-1', revision: 4, client: { clientId: 'id', clientSecret: 'secret' }, tokens: tokens('old-access') });

    client.emit({ access_token: 'late-access' });
    await active.waitForTokenPersistence();
    client.fail = { response: { status: 400, data: { error: 'invalid_grant', error_description: 'private content' } } };

    await expect(active.getAccessToken()).rejects.toThrow(DriveReauthorizationRequiredError);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(repository.requireReauthorization).toHaveBeenCalledWith('generation-1', 4, 'invalid_grant', 1_700_000_000_000);
  });

  it('waits for a successful refresh merge before transitioning concurrent invalid_grant failures once', async () => {
    const client = new Client();
    const repository = repositoryStub();
    const alert = vi.fn().mockResolvedValue(undefined);
    let releaseMerge: ((value: boolean) => void) | undefined;
    repository.mergeRefreshedTokens.mockImplementation(() => new Promise<boolean>((resolve) => { releaseMerge = resolve; }));
    repository.requireReauthorization.mockResolvedValue(true);
    const gateway = new GoogleOAuthClientGateway(repository, alert, { create: () => client } as OAuth2ClientFactory, { now: () => 1_700_000_000_000 });
    const active = gateway.create({ generationId: 'generation-1', revision: 4, client: { clientId: 'id', clientSecret: 'secret' }, tokens: tokens('old-access') });
    client.emit({ access_token: 'new-access' });
    client.fail = { response: { status: 400, data: { error: 'invalid_grant' } } };

    const first = active.getAccessToken();
    const second = active.getAccessToken();
    await vi.waitFor(() => expect(releaseMerge).toBeTypeOf('function'));
    releaseMerge?.(true);

    await expect(Promise.all([first, second])).rejects.toThrow(DriveReauthorizationRequiredError);
    expect(repository.requireReauthorization).toHaveBeenCalledTimes(1);
    expect(repository.requireReauthorization).toHaveBeenCalledWith('generation-1', 5, 'invalid_grant', 1_700_000_000_000);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it('retries a later invalid_grant when a stale CAS transition loses', async () => {
    const client = new Client();
    const repository = repositoryStub();
    const alert = vi.fn().mockResolvedValue(undefined);
    repository.requireReauthorization.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const gateway = new GoogleOAuthClientGateway(repository, alert, { create: () => client } as OAuth2ClientFactory, { now: () => 1_700_000_000_000 });
    const active = gateway.create({ generationId: 'generation-1', revision: 4, client: { clientId: 'id', clientSecret: 'secret' }, tokens: tokens('old-access') });
    client.fail = { response: { status: 400, data: { error: 'invalid_grant' } } };

    await expect(active.getAccessToken()).rejects.toThrow(DriveReauthorizationRequiredError);
    await expect(active.getAccessToken()).rejects.toThrow(DriveReauthorizationRequiredError);

    expect(repository.requireReauthorization).toHaveBeenCalledTimes(2);
    expect(alert).toHaveBeenCalledTimes(1);
  });
});

function repositoryStub(): Record<keyof Pick<DriveCredentialRepositoryPort, 'mergeRefreshedTokens' | 'requireReauthorization'>, ReturnType<typeof vi.fn>> {
  return { mergeRefreshedTokens: vi.fn(), requireReauthorization: vi.fn() };
}
