import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import {
  SensorDriverPort,
  SensorDriverShutdownContext,
} from '../domain/ports/sensor-driver.port';
import { SensorConfig } from '../domain/sensor';
import { SensorEvent } from '../domain/sensor-event';
import { SensorReading } from '../domain/sensor-reading';
import { CameraSensorConfig, parseCameraConfig } from './camera.config';
import { CameraBackendPort, createCameraBackend } from './camera-backends';
import { completeWithinDriverShutdownContext } from './driver-shutdown';

const execFileAsync = promisify(execFile);

@Injectable()
export class CameraSensorAdapter implements SensorDriverPort {
  private readonly logger = new Logger(CameraSensorAdapter.name);
  private listener?: (event: SensorEvent) => void;
  private last: SensorReading = { value: '', timestamp: new Date(0) };
  private config?: SensorConfig;
  private cameraConfig?: CameraSensorConfig;
  private backend?: CameraBackendPort;
  private ffmpegAvailable = false;
  private mutex: Promise<string | null> = Promise.resolve(null);

  async init(config: SensorConfig): Promise<void> {
    this.config = config;
    this.cameraConfig = parseCameraConfig(config.config);
    this.backend = createCameraBackend(this.cameraConfig);

    // Create storage directory (EC-12)
    try {
      await fs.promises.mkdir(this.cameraConfig.storagePath, { recursive: true });
    } catch (err) {
      this.logger.warn(`Failed to create storage path ${this.cameraConfig.storagePath}: ${(err as Error).message}`);
    }

    // Check ffmpeg availability (EC-10)
    try {
      await execFileAsync(process.env.FFMPEG_PATH || 'ffmpeg', ['-version'], { timeout: 3000 });
      this.ffmpegAvailable = true;
    } catch (err) {
      this.logger.warn(`ffmpeg not available or check failed: ${(err as Error).message}`);
      this.ffmpegAvailable = false;
    }

    // Verify USB device access (EC-14)
    if (this.cameraConfig.type === 'usb') {
      const device = this.cameraConfig.device || '/dev/video0';
      try {
        await fs.promises.access(device, fs.constants.R_OK);
      } catch (err) {
        this.logger.warn(`Cannot access USB camera device ${device}: ${(err as Error).message}`);
      }
    }

    this.logger.log(`Camera sensor "${config.name}" initialized (type: ${this.cameraConfig.type})`);
  }

  async destroy(context?: SensorDriverShutdownContext): Promise<void> {
    const backend = this.backend;
    this.backend = undefined;
    this.listener = undefined;
    if (!backend?.destroy) return;

    const result = await completeWithinDriverShutdownContext(
      Promise.resolve().then(() => backend.destroy!()),
      context,
    );
    if (result === 'cancelled') this.logger.warn('Camera backend destroy timed out');
    if (result === 'failed') this.logger.warn('Camera backend destroy failed');
  }

  getState(): SensorReading {
    return this.last;
  }

  onEvent(callback: (event: SensorEvent) => void): void {
    this.listener = callback;
  }

  async healthCheck(): Promise<boolean> {
    if (!this.backend || !this.cameraConfig) return false;

    if ((this.cameraConfig.type === 'rtsp' || this.cameraConfig.type === 'usb') && !this.ffmpegAvailable) {
      return false;
    }

    const probe = async (): Promise<boolean> => {
      if (!this.backend) return false;
      return this.backend.probe();
    };

    return Promise.race([
      probe(),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
    ]);
  }

  /**
   * Capture snapshot on demand with mutex concurrency guard (EC-13).
   */
  async captureSnapshot(): Promise<string | null> {
    const task = async (): Promise<string | null> => {
      if (!this.backend || !this.cameraConfig || !this.config) {
        return null;
      }

      if ((this.cameraConfig.type === 'rtsp' || this.cameraConfig.type === 'usb') && !this.ffmpegAvailable) {
        this.logger.error(`Cannot capture snapshot for "${this.config.name}": ffmpeg is not available`);
        return null;
      }

      try {
        const buffer = await this.backend.captureSnapshot();
        const filename = `${this.config.id}_${Date.now()}.jpg`;
        const filePath = path.join(this.cameraConfig.storagePath, filename);

        // Save JPEG with try/catch for ENOSPC or write failure (EC-12)
        await fs.promises.writeFile(filePath, buffer);

        const oldValue = this.last.value;
        const now = new Date();
        this.last = {
          value: filePath,
          timestamp: now,
          raw: { path: filePath },
        };

        this.listener?.({
          sensorId: this.config.id,
          type: 'state_change',
          oldValue,
          newValue: filePath,
          timestamp: now,
        });

        return filePath;
      } catch (err) {
        this.logger.error(`Failed to capture/save snapshot for "${this.config.name}": ${(err as Error).message}`);
        return null;
      }
    };

    this.mutex = this.mutex.then(task, task);
    return this.mutex;
  }
}
