import { MODULE_METADATA } from '@nestjs/common/constants';
import { describe, expect, it, vi } from 'vitest';
import { CameraModule } from '../../../src/camera/camera.module';
import type { LiveSourceRepositoryPort } from '../../../src/camera/domain/ports/live-source-repository.port';
import { LiveSourceCredentialRotationCoordinator } from '../../../src/camera/application/live-source-credential-rotation-coordinator.service';

describe('LiveSourceCredentialRotationCoordinator', () => {
  it('is a production provider and awaits startup rotation', async () => {
    const repository = {
      rotate: vi.fn().mockResolvedValue(undefined),
    } as unknown as LiveSourceRepositoryPort;
    const coordinator = new LiveSourceCredentialRotationCoordinator(repository);

    await coordinator.onModuleInit();

    expect(repository.rotate).toHaveBeenCalledOnce();
    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      CameraModule,
    ) as readonly unknown[];
    expect(providers).toContain(LiveSourceCredentialRotationCoordinator);
  });

  it('propagates rotation failure so application initialization fails closed', async () => {
    const failure = new Error('rotation failed');
    const repository = {
      rotate: vi.fn().mockRejectedValue(failure),
    } as unknown as LiveSourceRepositoryPort;

    await expect(
      new LiveSourceCredentialRotationCoordinator(repository).onModuleInit(),
    ).rejects.toBe(failure);
  });
});
