import { OAuth2Client, type Credentials } from 'google-auth-library';
import type {
  DriveClientCredentials,
  DriveCredentialRepositoryPort,
  OAuthTokenSet,
} from '../../application/ports/drive-credential-repository.port';
import { DriveConfigurationError } from '../../domain/errors/drive-configuration.error';
import { DrivePolicyBlockedError } from '../../domain/errors/drive-policy-blocked.error';
import { DriveRateLimitedError } from '../../domain/errors/drive-rate-limited.error';
import { DriveReauthorizationRequiredError } from '../../domain/errors/drive-reauthorization-required.error';
import { DriveTemporaryUnavailableError } from '../../domain/errors/drive-temporary-unavailable.error';

interface OAuth2ClientLike {
  setCredentials(credentials: Credentials): void;
  on(event: 'tokens', listener: (tokens: Credentials) => void): this;
  getAccessToken(): Promise<{ token?: string | null }>;
}

export interface OAuth2ClientFactory {
  create(client: DriveClientCredentials): OAuth2ClientLike;
}

export interface OAuthGatewayClock {
  now(): number;
}

export interface ActiveGoogleOAuthClient {
  getAccessToken(): Promise<string>;
  waitForTokenPersistence(): Promise<void>;
}

export interface CreateGoogleOAuthClient {
  generationId: string;
  revision: number;
  client: DriveClientCredentials;
  tokens: OAuthTokenSet;
}

/** Infrastructure-only OAuth client lifecycle and durable refresh fencing. */
export class GoogleOAuthClientGateway {
  constructor(
    private readonly credentials: Pick<DriveCredentialRepositoryPort, 'mergeRefreshedTokens' | 'requireReauthorization'>,
    private readonly factory: OAuth2ClientFactory = { create: (client) => new OAuth2Client({ clientId: client.clientId, clientSecret: client.clientSecret }) },
    private readonly clock: OAuthGatewayClock = { now: () => Date.now() },
    private readonly alertReauthorizationRequired: (generationId: string) => Promise<void> = async () => undefined,
  ) {}

  create(input: CreateGoogleOAuthClient): ActiveGoogleOAuthClient {
    const client = this.factory.create(input.client);
    client.setCredentials(toGoogleCredentials(input.tokens));
    return new ActiveClient(
      client,
      input.generationId,
      input.revision,
      input.tokens,
      this.credentials,
      this.clock,
      this.alertReauthorizationRequired,
    );
  }
}

class ActiveClient implements ActiveGoogleOAuthClient {
  private revision: number;
  private tokens: OAuthTokenSet;
  private persistence = Promise.resolve();
  private reauthorizationRequested = false;

  constructor(
    private readonly client: OAuth2ClientLike,
    private readonly generationId: string,
    revision: number,
    tokens: OAuthTokenSet,
    private readonly credentials: Pick<DriveCredentialRepositoryPort, 'mergeRefreshedTokens' | 'requireReauthorization'>,
    private readonly clock: OAuthGatewayClock,
    private readonly alertReauthorizationRequired: (generationId: string) => Promise<void>,
  ) {
    this.revision = revision;
    this.tokens = { ...tokens };
    this.client.on('tokens', (event) => this.enqueueTokens(event));
  }

  async getAccessToken(): Promise<string> {
    try {
      const result = await this.client.getAccessToken();
      await this.persistence;
      if (!result.token) throw new DriveReauthorizationRequiredError();
      return result.token;
    } catch (error) {
      if (isInvalidGrant(error)) {
        await this.requireReauthorization(error);
      }
      throw mapGoogleAuthFailure(error);
    }
  }

  async waitForTokenPersistence(): Promise<void> {
    await this.persistence;
  }

  private enqueueTokens(value: Credentials): void {
    this.persistence = this.persistence.then(async () => {
      const tokens = mergeTokens(this.tokens, value);
      const expectedRevision = this.revision;
      const merged = await this.credentials.mergeRefreshedTokens({
        generationId: this.generationId,
        expectedRevision,
        tokens,
        refreshedAtMs: this.clock.now(),
      });
      if (merged) {
        this.tokens = tokens;
        this.revision += 1;
      }
    });
  }

  private async requireReauthorization(_error: unknown): Promise<void> {
    if (this.reauthorizationRequested) return;
    this.reauthorizationRequested = true;
    const transitioned = await this.credentials.requireReauthorization(
      this.generationId,
      this.revision,
      'invalid_grant',
      this.clock.now(),
    );
    if (transitioned) await this.alertReauthorizationRequired(this.generationId);
  }
}

function toGoogleCredentials(tokens: OAuthTokenSet): Credentials {
  return {
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    expiry_date: tokens.expiryDateMs,
    token_type: tokens.tokenType,
    scope: tokens.scope ?? undefined,
  };
}

function mergeTokens(existing: OAuthTokenSet, value: Credentials): OAuthTokenSet {
  return {
    accessToken: optionalString(value.access_token, existing.accessToken),
    refreshToken: optionalString(value.refresh_token, existing.refreshToken),
    expiryDateMs: optionalNumber(value.expiry_date, existing.expiryDateMs),
    tokenType: optionalString(value.token_type, existing.tokenType),
    scope: optionalString(value.scope, existing.scope),
  };
}

function optionalString(value: unknown, fallback: string | null): string | null {
  return value === undefined ? fallback : typeof value === 'string' ? value : null;
}

function optionalNumber(value: unknown, fallback: number | null): number | null {
  return value === undefined ? fallback : typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function isInvalidGrant(value: unknown): boolean {
  return isRecord(value)
    && isRecord(value.response)
    && isRecord(value.response.data)
    && value.response.data.error === 'invalid_grant';
}

function mapGoogleAuthFailure(value: unknown): Error {
  if (value instanceof DriveReauthorizationRequiredError || value instanceof DriveConfigurationError || value instanceof DrivePolicyBlockedError || value instanceof DriveRateLimitedError || value instanceof DriveTemporaryUnavailableError) return value;
  const error = providerError(value);
  switch (error) {
    case 'invalid_grant': return new DriveReauthorizationRequiredError();
    case 'invalid_client': return new DriveConfigurationError('Google OAuth client is invalid');
    case 'admin_policy_enforced':
    case 'org_internal': return new DrivePolicyBlockedError();
    default:
      return providerStatus(value) === 429 ? new DriveRateLimitedError() : new DriveTemporaryUnavailableError();
  }
}

function providerError(value: unknown): unknown {
  return isRecord(value) && isRecord(value.response) && isRecord(value.response.data) ? value.response.data.error : undefined;
}

function providerStatus(value: unknown): number | undefined {
  return isRecord(value) && isRecord(value.response) && typeof value.response.status === 'number' ? value.response.status : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
