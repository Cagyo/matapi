import { Inject, Injectable } from '@nestjs/common';
import type { RegisterArchiveArtifact } from '../../archive/domain/archive-artifact.entity';
import {
  ARCHIVE_REGISTRATION_LOOKUP,
  type ArchiveRegistrationLookupPort,
} from '../../archive/application/ports/archive-registration-lookup.port';
import {
  ARCHIVE_REGISTRATION,
  type ArchiveRegistrationPort,
} from '../../archive/application/ports/archive-registration.port';
import {
  COMPLETED_MOTION_VIDEO,
  type CompletedMotionVideoCandidate,
  type CompletedMotionVideoDescriptor,
  type CompletedMotionVideoPort,
  type CompletedMotionVideoTraversal,
} from '../domain/ports/completed-motion-video.port';
import {
  MEDIA_REPOSITORY,
  type MediaRepositoryPort,
} from '../domain/ports/media-repository.port';
import {
  MEDIA_WRITER,
  type MediaWriterPort,
} from '../domain/ports/media-writer.port';
import {
  MONOTONIC_CLOCK,
  type MonotonicClockPort,
} from '../domain/ports/monotonic-clock.port';

const RECONCILIATION_LIMIT = 64;

export interface CompletedMotionRecoveryOptions {
  entryLimit: number;
  hashByteLimit: number;
  wallTimeMs: number;
  descriptorLimit: number;
}

export interface CompletedMotionRecoveryWorkResult {
  complete: boolean;
  madeProgress: boolean;
  budgetExhausted: boolean;
}

interface CandidateWorkResult {
  hashedBytes: number;
  registered: boolean;
  inProgress: boolean;
  madeProgress: boolean;
  deferred: boolean;
}

interface DeferredCandidate {
  traversal: CompletedMotionVideoTraversal;
  candidate: CompletedMotionVideoCandidate;
}

/** Registers validated Motion files and makes DB event rows point at the artifact. */
@Injectable()
export class RegisterCompletedMotionVideosUseCase {
  /** One offered-but-unhashed candidate, owned by the currently open traversal. */
  private deferredCandidate: DeferredCandidate | null = null;

  constructor(
    @Inject(MEDIA_REPOSITORY)
    private readonly media: Pick<MediaRepositoryPort,
      'findEventById' | 'findUnarchivedCompletedVideos' | 'findCompletedEventsByVideoPath'>,
    @Inject(COMPLETED_MOTION_VIDEO)
    private readonly completedVideos: CompletedMotionVideoPort,
    @Inject(ARCHIVE_REGISTRATION)
    private readonly archive: ArchiveRegistrationPort,
    @Inject(ARCHIVE_REGISTRATION_LOOKUP)
    private readonly archiveLookup: ArchiveRegistrationLookupPort,
    @Inject(MONOTONIC_CLOCK)
    private readonly monotonic: MonotonicClockPort,
    private readonly installationId: string | null,
    @Inject(MEDIA_WRITER)
    private readonly writer: Pick<MediaWriterPort,
      'createCompletedEvent' | 'attachArchiveArtifact' | 'deferArchiveRegistration'>,
  ) {}

  async executeForEvent(eventId: number): Promise<void> {
    const event = await this.media.findEventById(eventId);
    if (!event?.videoPath || !event.endedAt || event.archiveArtifactId) return;

    const signal = new AbortController().signal;
    const traversal = await this.completedVideos.openTraversal(signal);
    try {
      const candidate = await traversal.inspect(event.videoPath, signal);
      if (candidate === null) {
        await this.writer.deferArchiveRegistration([event.id]);
        return;
      }
      const matching = await this.media.findCompletedEventsByVideoPath(candidate.trustedPath);
      let result = await this.processCandidate(
        traversal,
        candidate,
        matching.length > 0 ? matching.map(({ id }) => id) : [event.id],
        Number.MAX_SAFE_INTEGER,
        Number.POSITIVE_INFINITY,
        signal,
      );
      while (result.inProgress) {
        result = await this.processCandidate(
          traversal,
          candidate,
          matching.length > 0 ? matching.map(({ id }) => id) : [event.id],
          Number.MAX_SAFE_INTEGER,
          Number.POSITIVE_INFINITY,
          signal,
        );
      }
    } finally {
      await traversal.close();
    }
  }

  async reconcileBatch(
    traversal: CompletedMotionVideoTraversal,
    options: CompletedMotionRecoveryOptions,
    signal: AbortSignal,
  ): Promise<CompletedMotionRecoveryWorkResult> {
    throwIfAborted(signal);
    if (options.descriptorLimit < 1 || options.wallTimeMs < 1) {
      return { complete: false, madeProgress: false, budgetExhausted: true };
    }

    const deadline = this.monotonic.now() + options.wallTimeMs;
    let hashBytesRemaining = Math.max(0, options.hashByteLimit);
    let accepted = 0;
    let madeProgress = false;
    const entryLimit = boundedEntryLimit(options.entryLimit);
    let entriesUsed = 0;

    if (this.deferredCandidate?.traversal !== traversal) this.deferredCandidate = null;

    const partial = traversal.pendingCandidate();
    if (partial !== null) {
      const matching = await this.media.findCompletedEventsByVideoPath(partial.trustedPath);
      throwIfAborted(signal);
      const resumed = await this.processCandidate(
        traversal,
        partial,
        matching.map(({ id }) => id),
        hashBytesRemaining,
        deadline,
        signal,
      );
      hashBytesRemaining -= resumed.hashedBytes;
      accepted += resumed.registered ? 1 : 0;
      madeProgress ||= resumed.madeProgress;
      if (resumed.inProgress) {
        return { complete: false, madeProgress, budgetExhausted: true };
      }
    }

    const deferred = this.takeDeferredCandidate(traversal);
    if (deferred !== null) {
      if (this.monotonic.now() >= deadline) {
        this.deferCandidate(traversal, deferred);
        return { complete: false, madeProgress, budgetExhausted: true };
      }
      const matching = await this.media.findCompletedEventsByVideoPath(deferred.trustedPath);
      throwIfAborted(signal);
      const resumed = await this.processCandidate(
        traversal,
        deferred,
        matching.map(({ id }) => id),
        hashBytesRemaining,
        deadline,
        signal,
      );
      hashBytesRemaining -= resumed.hashedBytes;
      accepted += resumed.registered ? 1 : 0;
      madeProgress ||= resumed.madeProgress;
      if (resumed.deferred) this.deferCandidate(traversal, deferred);
      if (resumed.inProgress || resumed.deferred) {
        return { complete: false, madeProgress, budgetExhausted: true };
      }
    }

    if (this.budgetReached(hashBytesRemaining, accepted, deadline, options)) {
      return { complete: false, madeProgress, budgetExhausted: true };
    }

    // Preserve one entry for the filesystem traversal whenever it has any
    // budget. Otherwise an unchanged oldest DB row can permanently consume a
    // batch before the traversal observes new Motion files.
    const pendingEntryLimit = Math.max(0, entryLimit - 1);
    if (pendingEntryLimit > 0) {
      const pending = await this.media.findUnarchivedCompletedVideos(RECONCILIATION_LIMIT);
      throwIfAborted(signal);
      for (const event of pending) {
        throwIfAborted(signal);
        if (entriesUsed >= pendingEntryLimit
          || this.budgetReached(hashBytesRemaining, accepted, deadline, options)) break;
        if (!event.videoPath) continue;

        // A DB-owned path still enters the same filesystem boundary as a
        // discovered path, so it spends one shared entry slot.
        entriesUsed += 1;
        const candidate = await traversal.inspect(event.videoPath, signal);
        throwIfAborted(signal);
        if (candidate === null) {
          await this.writer.deferArchiveRegistration([event.id]);
          throwIfAborted(signal);
          continue;
        }
        const matching = await this.media.findCompletedEventsByVideoPath(candidate.trustedPath);
        throwIfAborted(signal);
        const result = await this.processCandidate(
          traversal,
          candidate,
          matching.map(({ id }) => id),
          hashBytesRemaining,
          deadline,
          signal,
        );
        hashBytesRemaining -= result.hashedBytes;
        accepted += result.registered ? 1 : 0;
        madeProgress ||= result.madeProgress;
        if (result.deferred) this.deferCandidate(traversal, candidate);
        if (result.inProgress || result.deferred || accepted >= options.descriptorLimit) {
          return { complete: false, madeProgress, budgetExhausted: true };
        }
      }
    }

    let traversalComplete = false;
    while (entriesUsed < entryLimit) {
      throwIfAborted(signal);
      if (this.budgetReached(hashBytesRemaining, accepted, deadline, options)) {
        return { complete: false, madeProgress, budgetExhausted: true };
      }

      const step = await traversal.nextCandidate({
        entryLimit: entryLimit - entriesUsed,
      }, signal);
      throwIfAborted(signal);
      const visitedEntries = boundedVisitedEntries(step.visitedEntries, entryLimit - entriesUsed);
      entriesUsed += visitedEntries;
      madeProgress ||= visitedEntries > 0;
      traversalComplete = step.complete;
      if (step.candidate === null) {
        if (step.complete) break;
        if (visitedEntries === 0) {
          return { complete: false, madeProgress, budgetExhausted: true };
        }
        continue;
      }

      const matching = await this.media.findCompletedEventsByVideoPath(step.candidate.trustedPath);
      throwIfAborted(signal);
      const result = await this.processCandidate(
        traversal,
        step.candidate,
        matching.map(({ id }) => id),
        hashBytesRemaining,
        deadline,
        signal,
      );
      hashBytesRemaining -= result.hashedBytes;
      accepted += result.registered ? 1 : 0;
      madeProgress ||= result.madeProgress;
      if (result.deferred) this.deferCandidate(traversal, step.candidate);
      if (result.inProgress || result.deferred || accepted >= options.descriptorLimit) {
        return { complete: false, madeProgress, budgetExhausted: true };
      }
      if (visitedEntries === 0) {
        return { complete: false, madeProgress, budgetExhausted: true };
      }
    }

    return {
      complete: traversalComplete,
      madeProgress,
      budgetExhausted: !traversalComplete,
    };
  }

  /** Called by the traversal owner immediately before it closes the handle. */
  discardDeferredCandidate(traversal: CompletedMotionVideoTraversal): void {
    if (this.deferredCandidate?.traversal === traversal) this.deferredCandidate = null;
  }

  private budgetReached(
    hashBytesRemaining: number,
    accepted: number,
    deadlineMonotonicMs: number,
    options: CompletedMotionRecoveryOptions,
  ): boolean {
    return hashBytesRemaining < 1
      || accepted >= options.descriptorLimit
      || this.monotonic.now() >= deadlineMonotonicMs;
  }

  private async processCandidate(
    traversal: CompletedMotionVideoTraversal,
    candidate: CompletedMotionVideoCandidate,
    eventIds: readonly number[],
    hashByteLimit: number,
    deadlineMonotonicMs: number,
    signal: AbortSignal,
  ): Promise<CandidateWorkResult> {
    throwIfAborted(signal);
    const isPartial = traversal.pendingCandidate() === candidate;
    if (!isPartial) {
      const known = await this.archiveLookup.findKnown({
        installationId: this.requireInstallationId(),
        kind: 'motion_video',
        sourceIdentity: candidate.sourceIdentity,
        size: candidate.size,
        mtimeNs: candidate.mtimeNs,
      });
      throwIfAborted(signal);
      if (known !== null) {
        if (eventIds.length > 0) {
          await this.writer.attachArchiveArtifact([...new Set(eventIds)], known.artifactId);
          throwIfAborted(signal);
        }
        return {
          hashedBytes: 0,
          registered: false,
          inProgress: false,
          madeProgress: eventIds.length > 0,
          deferred: false,
        };
      }
      if (this.monotonic.now() >= deadlineMonotonicMs) {
        return {
          hashedBytes: 0,
          registered: false,
          inProgress: false,
          madeProgress: false,
          deferred: true,
        };
      }
    }

    const hashed = await traversal.continueHash(candidate, {
      hashByteLimit,
      deadlineMonotonicMs,
    }, signal);
    throwIfAborted(signal);
    if (hashed.kind === 'in-progress') {
      return {
        hashedBytes: hashed.hashedBytes,
        registered: false,
        inProgress: true,
        madeProgress: hashed.hashedBytes > 0,
        deferred: false,
      };
    }
    if (hashed.kind === 'rejected') {
      return {
        hashedBytes: hashed.hashedBytes,
        registered: false,
        inProgress: false,
        madeProgress: hashed.hashedBytes > 0,
        deferred: false,
      };
    }

    const attachedIds = eventIds.length > 0
      ? [...new Set(eventIds)]
      : [(await this.writer.createCompletedEvent(
          null,
          new Date(hashed.descriptor.sourceTimeMs),
          new Date(hashed.descriptor.sourceTimeMs),
          hashed.descriptor.trustedPath,
        )).id];
    throwIfAborted(signal);
    await this.registerDescriptor(hashed.descriptor, attachedIds);
    throwIfAborted(signal);
    return {
      hashedBytes: hashed.hashedBytes,
      registered: true,
      inProgress: false,
      madeProgress: true,
      deferred: false,
    };
  }

  private takeDeferredCandidate(
    traversal: CompletedMotionVideoTraversal,
  ): CompletedMotionVideoCandidate | null {
    if (this.deferredCandidate?.traversal !== traversal) return null;
    const candidate = this.deferredCandidate.candidate;
    this.deferredCandidate = null;
    return candidate;
  }

  private deferCandidate(
    traversal: CompletedMotionVideoTraversal,
    candidate: CompletedMotionVideoCandidate,
  ): void {
    this.deferredCandidate = { traversal, candidate };
  }

  private async registerDescriptor(
    descriptor: CompletedMotionVideoDescriptor,
    eventIds: readonly number[],
  ): Promise<void> {
    const artifact = await this.archive.register(this.toArchiveArtifact(descriptor));
    await this.writer.attachArchiveArtifact([...new Set(eventIds)], artifact.id);
  }

  private toArchiveArtifact(descriptor: CompletedMotionVideoDescriptor): RegisterArchiveArtifact {
    return { installationId: this.requireInstallationId(), ...descriptor };
  }

  private requireInstallationId(): string {
    if (this.installationId === null) {
      throw new Error('Archive installation identity is unavailable');
    }
    return this.installationId;
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('Aborted', 'AbortError');
  }
}

function boundedEntryLimit(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function boundedVisitedEntries(value: number, maximum: number): number {
  return Number.isSafeInteger(value) && value > 0
    ? Math.min(value, maximum)
    : 0;
}
