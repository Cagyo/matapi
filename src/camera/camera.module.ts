import { Module } from '@nestjs/common';
import { MotionService } from './motion.service';
import { UploadService } from './upload.service';
import { CleanupService } from './cleanup.service';

@Module({
  providers: [MotionService, UploadService, CleanupService],
  exports: [MotionService, UploadService, CleanupService],
})
export class CameraModule {}
