import { Injectable } from '@nestjs/common';
import type { CameraClockPort } from '../domain/ports/camera-clock.port';

@Injectable()
export class SystemCameraClockAdapter implements CameraClockPort {
  now(): Date {
    return new Date();
  }
}
