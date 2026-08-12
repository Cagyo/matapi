import { describe, expect, it, vi } from 'vitest';
import type { ClockPort } from '../../../src/events/domain/ports/clock.port';
import type { PendingDriveConnection } from '../../../src/archive/application/use-cases/begin-drive-connection.use-case';
import { SubmitDriveClientUseCase } from '../../../src/archive/application/use-cases/submit-drive-client.use-case';
import type { DeviceAuthorizationChallenge } from '../../../src/archive/application/ports/drive-device-authorization.port';
import { DriveSetupExpiredError } from '../../../src/archive/domain/errors/drive-setup-expired.error';
import { DriveSetupBusyError } from '../../../src/archive/domain/errors/drive-setup-busy.error';
import { DriveTemporaryUnavailableError } from '../../../src/archive/domain/errors/drive-temporary-unavailable.error';
import { InMemoryDriveCredentialRepository } from '../../../src/archive/infrastructure/persistence/in-memory-drive-credential.repository';

const nowMs = 10_000;

describe('SubmitDriveClientUseCase', () => {
  it('fences the challenge before starting polling and returns its effective deadline', async () => {
    const fixture = createFixture();
    const result = await fixture.useCase.execute({
      pending: fixture.pending,
      document: validClientJson(),
      signal: fixture.signal,
      authorizationSignal: fixture.authorizationSignal,
      acceptChallenge: fixture.acceptChallenge,
    });

    expect(result.effectiveDeadlineMs).toBe(nowMs + 120_000);
    expect(fixture.acceptChallenge).toHaveBeenCalledWith({
      generationId: fixture.pending.generationId,
      effectiveDeadlineMs: nowMs + 120_000,
    });
    expect(fixture.polling.start).toHaveBeenCalledWith(expect.objectContaining({
      signal: fixture.authorizationSignal,
      challenge: expect.objectContaining({ expiresAtMs: nowMs + 120_000 }),
    }));
  });

  it('rejects an expired invitation before staging credentials', async () => {
    const fixture = createFixture();

    await expect(fixture.useCase.execute({
      pending: pendingFixture({ expiresAtMs: nowMs }), document: validClientJson(),
      signal: fixture.signal, authorizationSignal: fixture.authorizationSignal,
      acceptChallenge: fixture.acceptChallenge,
    })).rejects.toBeInstanceOf(DriveSetupExpiredError);

    expect(fixture.credentials.stage).not.toHaveBeenCalled();
  });

  it('rejects malformed client documents before staging credentials', async () => {
    const fixture = createFixture();

    await expect(fixture.useCase.execute({
      pending: fixture.pending, document: '{bad-json', signal: fixture.signal,
      authorizationSignal: fixture.authorizationSignal, acceptChallenge: fixture.acceptChallenge,
    })).rejects.toMatchObject({ reason: 'malformed-json' });

    expect(fixture.credentials.stage).not.toHaveBeenCalled();
  });

  it('discards only its staged generation when requesting a challenge fails', async () => {
    const fixture = createFixture();
    fixture.authorization.requestCode.mockRejectedValueOnce(new DriveTemporaryUnavailableError());

    await expect(fixture.useCase.execute({
      pending: fixture.pending, document: validClientJson(), signal: fixture.signal,
      authorizationSignal: fixture.authorizationSignal, acceptChallenge: fixture.acceptChallenge,
    })).rejects.toBeInstanceOf(DriveTemporaryUnavailableError);

    expect(fixture.credentials.discardStaged).toHaveBeenCalledWith(
      fixture.pending.generationId, fixture.pending.receiptId,
    );
    expect(fixture.polling.start).not.toHaveBeenCalled();
  });

  it('discards only its staged generation when its challenge binding is rejected', async () => {
    const fixture = createFixture();
    fixture.acceptChallenge.mockReturnValueOnce(false);

    await expect(fixture.useCase.execute({
      pending: fixture.pending, document: validClientJson(), signal: fixture.signal,
      authorizationSignal: fixture.authorizationSignal, acceptChallenge: fixture.acceptChallenge,
    })).rejects.toBeInstanceOf(DriveSetupExpiredError);

    expect(fixture.credentials.discardStaged).toHaveBeenLastCalledWith(
      fixture.pending.generationId, fixture.pending.receiptId,
    );
  });

  it('retains the old active generation when a replacement provider request fails', async () => {
    const credentials = new InMemoryDriveCredentialRepository();
    await activateOldGeneration(credentials);
    const pending = pendingFixture({ generationId: 'new-generation', receiptId: 'new-receipt' });
    const useCase = new SubmitDriveClientUseCase(
      credentials,
      { requestCode: vi.fn().mockRejectedValue(new DriveTemporaryUnavailableError()) },
      { start: vi.fn() },
      fixedClock(nowMs),
    );

    await expect(useCase.execute({
      pending, document: validClientJson(), signal: new AbortController().signal,
      authorizationSignal: new AbortController().signal, acceptChallenge: () => true,
    })).rejects.toBeInstanceOf(DriveTemporaryUnavailableError);

    expect((await credentials.loadActive())?.id).toBe('old-generation');
    expect(await credentials.loadStaged('new-receipt')).toBeNull();
  });

  it('never discards another administrator’s staged owner when submission is busy', async () => {
    const repository = new InMemoryDriveCredentialRepository();
    await repository.stage(stageInput('first-generation', 'first-receipt'));
    const discardStaged = vi.fn(repository.discardStaged.bind(repository));
    const useCase = new SubmitDriveClientUseCase(
      { stage: repository.stage.bind(repository), discardStaged },
      { requestCode: vi.fn() },
      { start: vi.fn() },
      fixedClock(nowMs),
    );
    const pending = pendingFixture({ generationId: 'second-generation', receiptId: 'second-receipt' });

    await expect(useCase.execute({
      pending, document: validClientJson(), signal: new AbortController().signal,
      authorizationSignal: new AbortController().signal, acceptChallenge: () => true,
    })).rejects.toBeInstanceOf(DriveSetupBusyError);

    expect(discardStaged).not.toHaveBeenCalledWith('first-generation', 'first-receipt');
    expect((await repository.loadStaged('first-receipt'))?.id).toBe('first-generation');
    expect(await repository.loadStaged('second-receipt')).toBeNull();
  });
});

function createFixture() {
  const pending = pendingFixture({ createdAtMs: nowMs, expiresAtMs: nowMs + 600_000 });
  const challenge = challengeFixture({ expiresAtMs: nowMs + 120_000 });
  const acceptChallenge = vi.fn().mockReturnValue(true);
  const credentials = {
    stage: vi.fn().mockResolvedValue({ id: pending.generationId, revision: 0 }),
    discardStaged: vi.fn().mockResolvedValue(true),
  };
  const authorization = { requestCode: vi.fn().mockResolvedValue(challenge) };
  const polling = { start: vi.fn() };
  const useCase = new SubmitDriveClientUseCase(
    credentials, authorization, polling, fixedClock(nowMs),
  );
  return {
    pending, acceptChallenge, credentials, authorization, polling, useCase,
    signal: new AbortController().signal,
    authorizationSignal: new AbortController().signal,
  };
}

function fixedClock(value: number): ClockPort { return { now: () => new Date(value) }; }

function pendingFixture(overrides: Partial<PendingDriveConnection> = {}): PendingDriveConnection {
  return {
    generationId: 'generation-00001', receiptId: 'abcdefghijklmnop',
    adminUserId: 7, chatId: 7, installationId: 'installation-1',
    createdAtMs: 10_000, expiresAtMs: 610_000, ...overrides,
  };
}

function challengeFixture(overrides: Partial<DeviceAuthorizationChallenge> = {}): DeviceAuthorizationChallenge {
  return {
    deviceCode: 'device-code', userCode: 'Ab9-Xy2',
    verificationUri: 'https://www.google.com/device', verificationUriComplete: null,
    intervalMs: 5_000, expiresAtMs: 130_000, ...overrides,
  };
}

function validClientJson(): string {
  return JSON.stringify({ installed: {
    client_id: '123-device.apps.googleusercontent.com', client_secret: 'secret_12345678',
  } });
}

async function activateOldGeneration(credentials: InMemoryDriveCredentialRepository): Promise<void> {
  await credentials.stage(stageInput('old-generation', 'old-receipt'));
  await credentials.storeExchangedTokens('old-generation', 0, {
    accessToken: null, refreshToken: 'old-refresh', expiryDateMs: null, tokenType: null, scope: null,
  });
  await credentials.activate({
    stagedId: 'old-generation', expectedRevision: 1, permissionId: 'old-permission', email: null, displayName: null,
    folders: { rootId: 'old-root', motionId: 'old-motion', backupsId: 'old-backups' }, activatedAtMs: nowMs,
  });
}

function stageInput(id: string, receiptId: string) {
  return {
    id, receiptId, installationId: 'installation-1', client: { clientId: '123-device.apps.googleusercontent.com', clientSecret: 'secret_12345678' },
    clientIdHash: id, adminUserId: 7, chatId: 7, createdAtMs: nowMs, expiresAtMs: nowMs + 600_000,
  };
}
