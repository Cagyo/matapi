import { CameraSensorConfig } from '../camera.config';
import { CameraBackendPort } from './camera-backend.interface';
import { LibcameraBackend } from './libcamera.backend';
import { MjpegBackend } from './mjpeg.backend';
import { RtspBackend } from './rtsp.backend';
import { UsbBackend } from './usb.backend';

export * from './camera-backend.interface';
export * from './rtsp.backend';
export * from './mjpeg.backend';
export * from './usb.backend';
export * from './libcamera.backend';

export function createCameraBackend(config: CameraSensorConfig): CameraBackendPort {
  switch (config.type) {
    case 'rtsp':
      return new RtspBackend(config);
    case 'mjpeg':
      return new MjpegBackend(config);
    case 'usb':
      return new UsbBackend(config);
    case 'libcamera':
      return new LibcameraBackend(config);
  }
}
