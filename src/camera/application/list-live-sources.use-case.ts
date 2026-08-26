import { Inject, Injectable } from '@nestjs/common';
import {
  LIVE_SOURCE_REPOSITORY,
  type LiveSourceRepositoryPort,
  type RedactedLiveSource,
} from '../domain/ports/live-source-repository.port';

/**
 * Credential-free read of the stored sources.
 *
 * Deliberately ungated, unlike every mutation. Two gates used to sit here —
 * `requireReady('rtsp')` and `assertCanStart('rtsp')` — and both were answering
 * questions this use case never asks: it starts no converter, touches no
 * credential and writes nothing. Worse, they made the one thing an admin needs
 * on a broken network impossible, because removal is reached *through* a
 * listing: with the start gate closed by a reinstall that never completed, or a
 * policy the inspector cannot describe, the sources could not be listed, so
 * they could not be selected, so they could not be removed. That is the same
 * lock-out `RtspSourceMutationService.retire` is carved out to prevent, and
 * carving out only the use case left it reachable one layer up.
 *
 * Removal and listing stay available while RTSP is unhealthy on purpose. Do not
 * "restore consistency" by re-adding a readiness check here; add it to the
 * caller's create/attach/replace paths instead, where it guards a converter.
 */
@Injectable()
export class ListLiveSourcesUseCase {
  constructor(
    @Inject(LIVE_SOURCE_REPOSITORY)
    private readonly repository: LiveSourceRepositoryPort,
  ) {}

  async execute(): Promise<RedactedLiveSource[]> {
    return this.repository.listRedacted();
  }
}
