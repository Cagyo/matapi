import { Inject, Injectable } from '@nestjs/common';
import { InvalidLiveSourceError } from '../../camera/domain/errors/invalid-live-source.error';
import { LiveSource } from '../../camera/domain/live-source.entity';
import {
  LIVE_SOURCE_REPOSITORY,
  type LiveSourceRepositoryPort,
} from '../../camera/domain/ports/live-source-repository.port';
import {
  MEDIA_REPOSITORY,
  type MediaRepositoryPort,
} from '../../camera/domain/ports/media-repository.port';
import type { ConfigSnapshotLiveSource } from '../domain/config-snapshot';

export interface CameraLiveSourceImportPlan {
  sources: readonly LiveSource[];
  configured: readonly string[];
}

@Injectable()
export class ImportCameraLiveSourcesUseCase {
  constructor(
    @Inject(MEDIA_REPOSITORY) private readonly media: MediaRepositoryPort,
    @Inject(LIVE_SOURCE_REPOSITORY)
    private readonly repository: LiveSourceRepositoryPort,
  ) {}

  async prepare(
    imported: readonly ConfigSnapshotLiveSource[],
  ): Promise<CameraLiveSourceImportPlan> {
    const current = await this.repository.listRedacted();
    const currentByCamera = new Map(current.map((entry) => [entry.cameraId, entry]));
    const sources: LiveSource[] = [];
    const configured: string[] = [];
    for (const entry of imported) {
      const camera = await this.media.findCameraByName(entry.camera_name);
      if (!camera) throw new InvalidLiveSourceError('camera name is unknown');
      const source = LiveSource.create({
        cameraId: camera.id,
        url: `${entry.scheme}://${entry.host}`,
        transport: entry.transport,
        tlsMode: entry.tls_mode,
        profile: entry.profile,
        substream: entry.substream_host
          ? `${entry.scheme}://${entry.substream_host}`
          : null,
        ready: false,
      });
      const summary = source.summary();
      if (
        summary.host !== entry.host ||
        summary.scheme !== entry.scheme ||
        summary.substreamHost !== (entry.substream_host ?? null)
      ) {
        throw new InvalidLiveSourceError('metadata authority is not canonical');
      }
      const existing = currentByCamera.get(camera.id);
      if (
        existing?.summary.ready === false &&
        JSON.stringify(existing.summary) === JSON.stringify(summary)
      ) {
        continue;
      }
      sources.push(source);
      configured.push(entry.camera_name);
    }
    return { sources, configured };
  }

  async commit(plan: CameraLiveSourceImportPlan): Promise<readonly string[]> {
    await this.repository.saveMetadataBatch(plan.sources);
    return plan.configured;
  }
}
