import { afterEach, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMPLETED_MOTION_VIDEO } from '../../src/camera/domain/ports/completed-motion-video.port';
import { FsCompletedMotionVideoAdapter } from '../../src/camera/infrastructure/fs-completed-motion-video.adapter';
import { CameraModule } from '../../src/camera/camera.module';

describe('CameraModule archive composition', () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousCameraMode = process.env.CAMERA_MODE;
  const tempDirectories: string[] = [];

  afterEach(async () => {
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousCameraMode === undefined) delete process.env.CAMERA_MODE;
    else process.env.CAMERA_MODE = previousCameraMode;
    await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('starts with a factory-composed completed-video adapter', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'camera-module-'));
    tempDirectories.push(directory);
    process.env.DATABASE_PATH = join(directory, 'worker.sqlite');
    process.env.CAMERA_MODE = 'stub';
    const app = await NestFactory.createApplicationContext(CameraModule, { logger: false });
    try {
      expect(app.get(COMPLETED_MOTION_VIDEO)).toBeInstanceOf(FsCompletedMotionVideoAdapter);
    } finally {
      await app.close();
    }
  });
});
