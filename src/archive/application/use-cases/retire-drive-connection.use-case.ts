import type { ClockPort } from '../../../events/domain/ports/clock.port';
import type { DriveDeviceAuthorizationPort } from '../ports/drive-device-authorization.port';
import type { DriveCredentialRepositoryPort } from '../ports/drive-credential-repository.port';
import type { DriveConnection } from '../../domain/drive-connection.entity';
import type { DriveConnectionTerminalStatus } from '../ports/drive-credential-repository.port';
import { DriveTemporaryUnavailableError } from '../../domain/errors/drive-temporary-unavailable.error';
import { ArchiveRemoteMutationLockService } from '../archive-remote-mutation-lock.service';

const REVOCATION_TIMEOUT_MS = 5_000;

/** Retires a replaced generation or disconnects the current one without retaining secrets. */
export class RetireDriveConnectionUseCase {
  constructor(
    private readonly credentials: Pick<DriveCredentialRepositoryPort, 'loadCredentials' | 'beginDisconnect' | 'completeSecretRemoval'>,
    private readonly authorization: Pick<DriveDeviceAuthorizationPort, 'revoke'>,
    private readonly clock: ClockPort,
    private readonly remoteMutationLock: Pick<ArchiveRemoteMutationLockService, 'runExclusive'> =
      new ArchiveRemoteMutationLockService(),
  ) {}

  async execute(connection: DriveConnection, signal?: AbortSignal): Promise<void> {
    await this.remoteMutationLock.runExclusive(() => this.executeExclusive(connection, signal));
  }

  private async executeExclusive(connection: DriveConnection, signal?: AbortSignal): Promise<void> {
    const terminal = terminalStatus(connection);
    const credentials = await this.credentials.loadCredentials(connection.id);
    if (connection.status === 'active' || connection.status === 'reauth_required') {
      await this.credentials.beginDisconnect(connection.id, connection.revision);
    }

    let revocationErrorCode: string | null = null;
    const token = credentials?.tokens.refreshToken ?? credentials?.tokens.accessToken;
    if (token) {
      try {
        await this.authorization.revoke(token, boundedSignal(signal));
      } catch (error) {
        revocationErrorCode = errorCode(error);
      }
    }
    await this.credentials.completeSecretRemoval(
      connection.id,
      terminal,
      this.clock.now().getTime(),
      revocationErrorCode,
    );
  }
}

function terminalStatus(connection: DriveConnection): DriveConnectionTerminalStatus {
  switch (connection.status) {
    case 'retiring': return 'retired_unmanaged';
    case 'disconnecting':
    case 'active':
    case 'reauth_required': return 'disconnected';
    default: throw new DriveTemporaryUnavailableError('Drive connection is not eligible for retirement');
  }
}

function boundedSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REVOCATION_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function errorCode(error: unknown): string {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : new DriveTemporaryUnavailableError().code;
}
