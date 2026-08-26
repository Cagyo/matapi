import { Injectable } from '@nestjs/common';
import type { RedactedLiveSource } from '../domain/ports/live-source-repository.port';
import { RtspSourceMutationService } from './rtsp-source-mutation.service';

export interface TestRtspSourceInput {
  actorUserId: number;
  cameraId: string;
}

/**
 * Re-probes the credential already on disk and reports what is stored.
 *
 * Deliberately not a mutation: the revision, `verifiedAt`, policy digest,
 * readiness and credential all come back exactly as they were, so testing a
 * camera can neither promote an unverified source nor demote a working one.
 */
@Injectable()
export class TestRtspSourceUseCase {
  constructor(private readonly mutations: RtspSourceMutationService) {}

  async execute(input: TestRtspSourceInput): Promise<RedactedLiveSource> {
    return this.mutations.verifyStored(input);
  }
}
