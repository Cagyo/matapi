import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ArchiveModule } from '../../src/archive/archive.module';
import { AppModule } from '../../src/app.module';
import { CameraModule } from '../../src/camera/camera.module';
import { TelegramModule } from '../../src/telegram/telegram.module';
import { ARCHIVE_REGISTRATION } from '../../src/archive/application/ports/archive-registration.port';
import { ARCHIVE_VERIFICATION } from '../../src/archive/application/ports/archive-verification.port';
import { ARCHIVE_ADMIN_ALERT } from '../../src/archive/application/ports/archive-admin-alert.port';
import { ArchiveRemoteMutationLockService } from '../../src/archive/application/archive-remote-mutation-lock.service';
import { ReconcileDriveUseCase } from '../../src/archive/application/use-cases/reconcile-drive.use-case';
import { ArchiveRuntimeLifecycleService } from '../../src/archive/application/archive-runtime-lifecycle.service';
import { ArchiveAdminAlertService } from '../../src/archive/application/archive-admin-alert.service';
import { ReportDriveStatusUseCase } from '../../src/archive/application/use-cases/report-drive-status.use-case';
import { CLOCK } from '../../src/events/domain/ports/clock.port';
import { ArchiveSchedulerHooksService } from '../../src/archive/application/archive-scheduler.service';
import {
  DriveAuthorizationOutcomeRegistrationService,
} from '../../src/archive/application/drive-authorization-polling.service';
import { BeginDriveConnectionUseCase } from '../../src/archive/application/use-cases/begin-drive-connection.use-case';
import { SubmitDriveClientUseCase } from '../../src/archive/application/use-cases/submit-drive-client.use-case';
import { ConfirmDriveAccountUseCase } from '../../src/archive/application/use-cases/confirm-drive-account.use-case';
import { CancelDriveConnectionUseCase } from '../../src/archive/application/use-cases/cancel-drive-connection.use-case';
import { DisconnectDriveUseCase } from '../../src/archive/application/use-cases/disconnect-drive.use-case';

describe('ArchiveModule composition', () => {
  it('is imported by the application, Camera, and Telegram composition roots', () => {
    expect(Reflect.getMetadata('imports', AppModule)).toContain(ArchiveModule);
    expect(Reflect.getMetadata('imports', CameraModule)).toContain(ArchiveModule);
    expect(Reflect.getMetadata('imports', TelegramModule)).toContain(ArchiveModule);
  });

  it('exports ports, connection use cases, lifecycle, and registration seams without concrete adapters', () => {
    const exports = Reflect.getMetadata('exports', ArchiveModule) as unknown[];
    expect(exports).toEqual(expect.arrayContaining([
      ARCHIVE_REGISTRATION,
      ARCHIVE_VERIFICATION,
      BeginDriveConnectionUseCase,
      SubmitDriveClientUseCase,
      ConfirmDriveAccountUseCase,
      CancelDriveConnectionUseCase,
      DisconnectDriveUseCase,
      ArchiveRuntimeLifecycleService,
      ArchiveSchedulerHooksService,
      ArchiveRemoteMutationLockService,
      DriveAuthorizationOutcomeRegistrationService,
      ArchiveAdminAlertService,
      ReportDriveStatusUseCase,
    ]));
    expect(exports.some((value) => typeof value === 'function' && /Adapter|Repository/u.test(value.name))).toBe(false);
  });

  it('injects a real clock token into cooldown persistence', () => {
    const parameters = Reflect.getMetadata('self:paramtypes', ArchiveAdminAlertService) as
      | readonly { index: number; param: unknown }[]
      | undefined;
    expect(parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ index: 1, param: CLOCK }),
    ]));
  });

  it('binds a mandatory durable admin-alert adapter into reconciliation', () => {
    const providers = Reflect.getMetadata('providers', ArchiveModule) as {
      provide?: unknown;
      inject?: unknown[];
    }[];
    expect(providers.some(
      (provider) => provider.provide === ARCHIVE_ADMIN_ALERT,
    )).toBe(true);
    const reconcile = providers.find(
      (provider) => provider.provide === ReconcileDriveUseCase,
    );
    expect(reconcile).toMatchObject({ inject: expect.arrayContaining([ARCHIVE_ADMIN_ALERT]) });
  });
});
