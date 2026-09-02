import { describe, expect, it, vi } from 'vitest';
import type { ArchiveRegistrationLookupPort } from '../../../src/archive/application/ports/archive-registration-lookup.port';
import type { ArchiveRegistrationPort } from '../../../src/archive/application/ports/archive-registration.port';
import { RegisterCompletedMotionVideosUseCase } from '../../../src/camera/application/register-completed-motion-videos.use-case';
import type { MotionEvent } from '../../../src/camera/domain/motion-event.entity';
import type {
  CompletedMotionVideoCandidate,
  CompletedMotionVideoDescriptor,
  CompletedMotionVideoPort,
  CompletedMotionVideoTraversal,
} from '../../../src/camera/domain/ports/completed-motion-video.port';

const INSTALLATION_ID = 'installation-1';
const DEFAULT_OPTIONS = {
  entryLimit: 64,
  hashByteLimit: 1_024,
  wallTimeMs: 100,
  descriptorLimit: 16,
};

describe('RegisterCompletedMotionVideosUseCase', () => {
  it('skips an already-known immutable event candidate before hashing', async () => {
    const candidate = candidateFor(1);
    const handle = traversal({ inspect: vi.fn(async () => candidate) });
    const fixture = useCaseFixture({
      events: [motionEvent(1, candidate.trustedPath)],
      traversal: handle,
      knownArtifactId: 'artifact-1',
    });

    await fixture.subject.executeForEvent(1);
    await fixture.subject.executeForEvent(1);

    expect(fixture.lookup.findKnown).toHaveBeenCalledWith({
      installationId: INSTALLATION_ID,
      kind: 'motion_video',
      sourceIdentity: candidate.sourceIdentity,
      size: candidate.size,
      mtimeNs: candidate.mtimeNs,
    });
    expect(handle.continueHash).not.toHaveBeenCalled();
    expect(fixture.repository.attachArchiveArtifact).toHaveBeenCalledWith([1], 'artifact-1');
    expect(fixture.repository.attachArchiveArtifact).toHaveBeenCalledOnce();
    expect(fixture.completedVideos.openTraversal).toHaveBeenCalledOnce();
    expect(fixture.archive.register).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it.each(['empty', 'symlink', 'outside-root', 'partial', 'unexpected-extension', 'unstable'])(
    'defers an immediate %s candidate and closes its traversal',
    async () => {
      const handle = traversal({ inspect: vi.fn(async () => null) });
      const fixture = useCaseFixture({ events: [motionEvent(1)], traversal: handle });

      await fixture.subject.executeForEvent(1);

      expect(fixture.repository.deferArchiveRegistration).toHaveBeenCalledWith([1]);
      expect(fixture.archive.register).not.toHaveBeenCalled();
      expect(handle.close).toHaveBeenCalledOnce();
    },
  );

  it('checks the durable event state before opening an immediate traversal', async () => {
    const complete = motionEvent(1);
    const fixture = useCaseFixture({
      events: [
        { ...complete, id: 1, endedAt: null },
        { ...complete, id: 2, videoPath: null },
        { ...complete, id: 3, archiveArtifactId: 'artifact-3' },
      ],
    });

    await fixture.subject.executeForEvent(1);
    await fixture.subject.executeForEvent(2);
    await fixture.subject.executeForEvent(3);
    await fixture.subject.executeForEvent(4);

    expect(fixture.completedVideos.openTraversal).not.toHaveBeenCalled();
  });

  it('attaches a known pending event and advances the traversal without hashing', async () => {
    const candidate = candidateFor(1);
    const nextCandidate = vi.fn()
      .mockResolvedValueOnce({ candidate: null, visitedEntries: 2, complete: true });
    const handle = traversal({
      inspect: vi.fn(async () => candidate),
      nextCandidate,
    });
    const fixture = useCaseFixture({
      events: [motionEvent(1, candidate.trustedPath)],
      traversal: handle,
      knownArtifactId: 'artifact-1',
    });

    await expect(fixture.subject.reconcileBatch(
      handle,
      DEFAULT_OPTIONS,
      new AbortController().signal,
    )).resolves.toEqual({ complete: true, madeProgress: true, budgetExhausted: false });

    expect(handle.continueHash).not.toHaveBeenCalled();
    expect(fixture.repository.attachArchiveArtifact).toHaveBeenCalledWith([1], 'artifact-1');
    expect(nextCandidate).toHaveBeenCalledOnce();
  });

  it('makes known-only filesystem progress without creating phantom events', async () => {
    const candidates = [candidateFor(1), candidateFor(2), candidateFor(3)];
    let index = 0;
    const handle = traversal({
      nextCandidate: vi.fn(async () => index < candidates.length
        ? { candidate: candidates[index++], visitedEntries: 1, complete: false }
        : { candidate: null, visitedEntries: 0, complete: true }),
    });
    const fixture = useCaseFixture({ traversal: handle, knownArtifactId: 'artifact-known' });

    await expect(fixture.subject.reconcileBatch(
      handle,
      DEFAULT_OPTIONS,
      new AbortController().signal,
    )).resolves.toEqual({ complete: true, madeProgress: true, budgetExhausted: false });

    expect(fixture.lookup.findKnown).toHaveBeenCalledTimes(3);
    expect(handle.continueHash).not.toHaveBeenCalled();
    expect(fixture.repository.createCompletedEvent).not.toHaveBeenCalled();
    expect(fixture.archive.register).not.toHaveBeenCalled();
  });

  it('uses one hash-byte budget across a partial hash, pending events, and enumeration', async () => {
    const partial = candidateFor(1);
    const pending = candidateFor(2);
    const scanned = candidateFor(3);
    let active: CompletedMotionVideoCandidate | null = partial;
    let scanStep = 0;
    const hashLimits: number[] = [];
    const handle = traversal({
      pendingCandidate: vi.fn(() => active),
      inspect: vi.fn(async () => pending),
      nextCandidate: vi.fn(async () => scanStep++ === 0
        ? { candidate: scanned, visitedEntries: 1, complete: false }
        : { candidate: null, visitedEntries: 0, complete: true }),
      continueHash: vi.fn(async (candidate, input) => {
        hashLimits.push(input.hashByteLimit);
        active = null;
        if (candidate === partial) {
          return { kind: 'complete' as const, descriptor: descriptorFor(partial), hashedBytes: 2 };
        }
        if (candidate === pending) return { kind: 'rejected' as const, hashedBytes: 3 };
        return { kind: 'complete' as const, descriptor: descriptorFor(scanned), hashedBytes: 5 };
      }),
    });
    const fixture = useCaseFixture({
      events: [motionEvent(20, pending.trustedPath)],
      traversal: handle,
      options: { ...DEFAULT_OPTIONS, hashByteLimit: 10, descriptorLimit: 3 },
    });

    const result = await fixture.subject.reconcileBatch(
      handle,
      fixture.options,
      new AbortController().signal,
    );

    expect(hashLimits).toEqual([10, 8, 5]);
    expect(fixture.archive.register).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ complete: false, madeProgress: true, budgetExhausted: true });
  });

  it('debits bytes consumed by a rejected-after-read result', async () => {
    const candidates = [candidateFor(1), candidateFor(2)];
    let index = 0;
    const hashLimits: number[] = [];
    const handle = traversal({
      nextCandidate: vi.fn(async () => ({
        candidate: candidates[index++] ?? null,
        visitedEntries: 1,
        complete: false,
      })),
      continueHash: vi.fn(async (_candidate, input) => {
        hashLimits.push(input.hashByteLimit);
        return hashLimits.length === 1
          ? { kind: 'rejected' as const, hashedBytes: 6 }
          : { kind: 'in-progress' as const, hashedBytes: 4 };
      }),
    });
    const fixture = useCaseFixture({ traversal: handle });

    const result = await fixture.subject.reconcileBatch(
      handle,
      { ...DEFAULT_OPTIONS, hashByteLimit: 10 },
      new AbortController().signal,
    );

    expect(hashLimits).toEqual([10, 4]);
    expect(result).toEqual({ complete: false, madeProgress: true, budgetExhausted: true });
  });

  it('resumes one adapter-owned large-file hash before any new work', async () => {
    const candidate = candidateFor(1);
    let active: CompletedMotionVideoCandidate | null = null;
    let nextCalls = 0;
    const order: string[] = [];
    const handle = traversal({
      pendingCandidate: vi.fn(() => active),
      nextCandidate: vi.fn(async () => {
        order.push('next');
        if (nextCalls++ === 0) return { candidate, visitedEntries: 1, complete: false };
        return { candidate: null, visitedEntries: 0, complete: true };
      }),
      continueHash: vi.fn(async () => {
        order.push('hash');
        if (active === null) {
          active = candidate;
          return { kind: 'in-progress' as const, hashedBytes: 4 };
        }
        active = null;
        return { kind: 'complete' as const, descriptor: descriptorFor(candidate), hashedBytes: 3 };
      }),
    });
    const fixture = useCaseFixture({ traversal: handle });

    await expect(fixture.subject.reconcileBatch(
      handle,
      { ...DEFAULT_OPTIONS, hashByteLimit: 4 },
      new AbortController().signal,
    )).resolves.toEqual({ complete: false, madeProgress: true, budgetExhausted: true });
    order.push('batch-boundary');
    await expect(fixture.subject.reconcileBatch(
      handle,
      { ...DEFAULT_OPTIONS, hashByteLimit: 4 },
      new AbortController().signal,
    )).resolves.toEqual({ complete: true, madeProgress: true, budgetExhausted: false });

    expect(order).toEqual(['next', 'hash', 'batch-boundary', 'hash', 'next']);
    expect(fixture.lookup.findKnown).toHaveBeenCalledOnce();
    expect(fixture.archive.register).toHaveBeenCalledOnce();
  });

  it('continues beyond 64 videos with bounded one-at-a-time registration', async () => {
    const candidates = Array.from({ length: 65 }, (_, index) => candidateFor(index + 1));
    let index = 0;
    const order: string[] = [];
    const handle = traversal({
      nextCandidate: vi.fn(async () => {
        if (index >= candidates.length) return { candidate: null, visitedEntries: 0, complete: true };
        return { candidate: candidates[index++], visitedEntries: 1, complete: false };
      }),
      continueHash: vi.fn(async (candidate) => ({
        kind: 'complete' as const,
        descriptor: descriptorFor(candidate),
        hashedBytes: 1,
      })),
    });
    const fixture = useCaseFixture({
      traversal: handle,
      archiveRegister: async (input) => {
        order.push(`register:${input.sourceIdentity}`);
        return { id: `artifact-${order.length}` } as never;
      },
      onAttach: (ids) => order.push(`attach:${ids[0]}`),
    });
    const options = {
      entryLimit: 64,
      hashByteLimit: 64,
      wallTimeMs: 100,
      descriptorLimit: 64,
    };

    await expect(fixture.subject.reconcileBatch(
      handle,
      options,
      new AbortController().signal,
    )).resolves.toEqual({ complete: false, madeProgress: true, budgetExhausted: true });
    await expect(fixture.subject.reconcileBatch(
      handle,
      options,
      new AbortController().signal,
    )).resolves.toEqual({ complete: true, madeProgress: true, budgetExhausted: false });

    expect(fixture.archive.register).toHaveBeenCalledTimes(65);
    expect(fixture.repository.createCompletedEvent).toHaveBeenCalledTimes(65);
    expect(order).toHaveLength(130);
    for (let pair = 0; pair < order.length; pair += 2) {
      expect(order[pair]).toMatch(/^register:/u);
      expect(order[pair + 1]).toMatch(/^attach:/u);
    }
  });

  it('stops exactly at the entry boundary while descriptor capacity remains', async () => {
    const nextCandidate = vi.fn()
      .mockResolvedValueOnce({ candidate: null, visitedEntries: 2, complete: false });
    const handle = traversal({ nextCandidate });
    const fixture = useCaseFixture({ traversal: handle });

    await expect(fixture.subject.reconcileBatch(
      handle,
      { entryLimit: 2, hashByteLimit: 2, wallTimeMs: 5, descriptorLimit: 2 },
      new AbortController().signal,
    )).resolves.toEqual({ complete: false, madeProgress: true, budgetExhausted: true });

    expect(nextCandidate).toHaveBeenCalledOnce();
    expect(nextCandidate).toHaveBeenCalledWith({ entryLimit: 2 }, expect.any(AbortSignal));
  });

  it('stops exactly at the descriptor boundary while entry capacity remains', async () => {
    const candidate = candidateFor(1);
    const nextCandidate = vi.fn()
      .mockResolvedValueOnce({ candidate, visitedEntries: 2, complete: false });
    const handle = traversal({
      nextCandidate,
      continueHash: vi.fn(async () => ({
        kind: 'complete' as const,
        descriptor: descriptorFor(candidate),
        hashedBytes: 1,
      })),
    });
    const fixture = useCaseFixture({ traversal: handle });

    await expect(fixture.subject.reconcileBatch(
      handle,
      { entryLimit: 10, hashByteLimit: 2, wallTimeMs: 5, descriptorLimit: 1 },
      new AbortController().signal,
    )).resolves.toEqual({ complete: false, madeProgress: true, budgetExhausted: true });

    expect(nextCandidate).toHaveBeenCalledOnce();
    expect(nextCandidate).toHaveBeenCalledWith({ entryLimit: 10 }, expect.any(AbortSignal));
  });

  it('stops fresh work exactly at the wall-time boundary', async () => {
    const candidates = [candidateFor(1), candidateFor(2)];
    const clock = mutableClock();
    let index = 0;
    const nextCandidate = vi.fn(async () => ({
      candidate: candidates[index++] ?? null,
      visitedEntries: 1,
      complete: false,
    }));
    const handle = traversal({ nextCandidate });
    const fixture = useCaseFixture({ traversal: handle, knownArtifactId: 'artifact-known', clock });
    fixture.lookup.findKnown.mockImplementation(async () => {
      clock.nowMs = 5;
      return { artifactId: 'artifact-known' };
    });

    await expect(fixture.subject.reconcileBatch(
      handle,
      { entryLimit: 2, hashByteLimit: 2, wallTimeMs: 5, descriptorLimit: 2 },
      new AbortController().signal,
    )).resolves.toEqual({ complete: false, madeProgress: true, budgetExhausted: true });

    expect(nextCandidate).toHaveBeenCalledOnce();
    expect(handle.continueHash).not.toHaveBeenCalled();
  });

  it('defers a candidate when lookup reaches the deadline and resumes its exact identity first', async () => {
    const candidate = candidateFor(1);
    const clock = mutableClock();
    const order: string[] = [];
    let scanCalls = 0;
    const handle = traversal({
      nextCandidate: vi.fn(async () => {
        order.push('next');
        return scanCalls++ === 0
          ? { candidate, visitedEntries: 1, complete: false }
          : { candidate: null, visitedEntries: 1, complete: true };
      }),
      continueHash: vi.fn(async (offered) => {
        order.push('hash');
        expect(offered).toBe(candidate);
        return { kind: 'rejected' as const, hashedBytes: 0 };
      }),
    });
    const fixture = useCaseFixture({ traversal: handle, clock });
    let lookupCalls = 0;
    fixture.lookup.findKnown.mockImplementation(async () => {
      order.push('lookup');
      if (lookupCalls++ === 0) clock.nowMs = 5;
      return null;
    });
    const options = { entryLimit: 1, hashByteLimit: 10, wallTimeMs: 5, descriptorLimit: 1 };

    await expect(fixture.subject.reconcileBatch(
      handle,
      options,
      new AbortController().signal,
    )).resolves.toEqual({ complete: false, madeProgress: true, budgetExhausted: true });

    expect(handle.continueHash).not.toHaveBeenCalled();
    order.push('batch-boundary');

    await expect(fixture.subject.reconcileBatch(
      handle,
      options,
      new AbortController().signal,
    )).resolves.toEqual({ complete: true, madeProgress: true, budgetExhausted: false });

    expect(order).toEqual(['next', 'lookup', 'batch-boundary', 'lookup', 'hash', 'next']);
    expect(handle.continueHash).toHaveBeenCalledWith(candidate, {
      hashByteLimit: 10,
      deadlineMonotonicMs: 10,
    }, expect.any(AbortSignal));
  });

  it('does not start fresh work with zero entry, descriptor, or wall-time budget', async () => {
    const handle = traversal();
    const fixture = useCaseFixture({ traversal: handle });

    await expect(fixture.subject.reconcileBatch(
      handle,
      { entryLimit: 0, hashByteLimit: 1, wallTimeMs: 0, descriptorLimit: 0 },
      new AbortController().signal,
    )).resolves.toEqual({ complete: false, madeProgress: false, budgetExhausted: true });

    expect(handle.nextCandidate).not.toHaveBeenCalled();
    expect(handle.continueHash).not.toHaveBeenCalled();
    expect(fixture.repository.findUnarchivedCompletedVideos).not.toHaveBeenCalled();
  });

  it('does not start fresh work when the shared hash budget is zero', async () => {
    const handle = traversal();
    const fixture = useCaseFixture({ traversal: handle });

    await expect(fixture.subject.reconcileBatch(
      handle,
      { ...DEFAULT_OPTIONS, hashByteLimit: 0 },
      new AbortController().signal,
    )).resolves.toEqual({ complete: false, madeProgress: false, budgetExhausted: true });

    expect(fixture.repository.findUnarchivedCompletedVideos).not.toHaveBeenCalled();
    expect(handle.nextCandidate).not.toHaveBeenCalled();
  });

  it('retains a partial candidate when the next batch has no hash bytes', async () => {
    const candidate = candidateFor(1);
    const handle = traversal({
      pendingCandidate: vi.fn(() => candidate),
      continueHash: vi.fn(async () => ({ kind: 'in-progress' as const, hashedBytes: 0 })),
    });
    const fixture = useCaseFixture({ traversal: handle });

    await expect(fixture.subject.reconcileBatch(
      handle,
      { ...DEFAULT_OPTIONS, hashByteLimit: 0 },
      new AbortController().signal,
    )).resolves.toEqual({ complete: false, madeProgress: false, budgetExhausted: true });

    expect(handle.continueHash).toHaveBeenCalledWith(candidate, {
      hashByteLimit: 0,
      deadlineMonotonicMs: 100,
    }, expect.any(AbortSignal));
    expect(fixture.lookup.findKnown).not.toHaveBeenCalled();
  });

  it('reports progress for invalid and unstable-only batches', async () => {
    const events = Array.from({ length: 64 }, (_, index) => motionEvent(index + 1, `/motion/${index}.mp4`));
    const handle = traversal({
      inspect: vi.fn(async () => null),
      nextCandidate: vi.fn(async ({ entryLimit }) => ({
        candidate: null,
        visitedEntries: entryLimit,
        complete: false,
      })),
    });
    const fixture = useCaseFixture({ events, traversal: handle });

    await expect(fixture.subject.reconcileBatch(
      handle,
      DEFAULT_OPTIONS,
      new AbortController().signal,
    )).resolves.toEqual({ complete: false, madeProgress: true, budgetExhausted: true });

    expect(fixture.repository.deferArchiveRegistration).toHaveBeenCalledTimes(63);
    expect(handle.continueHash).not.toHaveBeenCalled();
  });

  it('reserves traversal progress across repeated invalid pending rows without counting no-op deferrals', async () => {
    const clock = mutableClock();
    let traversalTurn = 0;
    const inspect = vi.fn(async () => {
      clock.nowMs += 1;
      return null;
    });
    const nextCandidate = vi.fn(async () => ({
      candidate: null,
      visitedEntries: traversalTurn++ === 0 ? 0 : 1,
      complete: false,
    }));
    const handle = traversal({ inspect, nextCandidate });
    const fixture = useCaseFixture({
      clock,
      events: Array.from({ length: 4 }, (_, index) => motionEvent(index + 1)),
      traversal: handle,
    });
    const options = { entryLimit: 2, hashByteLimit: 10, wallTimeMs: 10, descriptorLimit: 1 };

    await expect(fixture.subject.reconcileBatch(
      handle,
      options,
      new AbortController().signal,
    )).resolves.toEqual({ complete: false, madeProgress: false, budgetExhausted: true });
    await expect(fixture.subject.reconcileBatch(
      handle,
      options,
      new AbortController().signal,
    )).resolves.toEqual({ complete: false, madeProgress: true, budgetExhausted: true });

    expect(inspect).toHaveBeenCalledTimes(2);
    expect(nextCandidate).toHaveBeenCalledTimes(2);
    expect(nextCandidate).toHaveBeenNthCalledWith(
      1,
      { entryLimit: 1 },
      expect.any(AbortSignal),
    );
    expect(nextCandidate).toHaveBeenNthCalledWith(
      2,
      { entryLimit: 1 },
      expect.any(AbortSignal),
    );
    expect(fixture.repository.deferArchiveRegistration).toHaveBeenCalledTimes(2);
    expect(handle.continueHash).not.toHaveBeenCalled();
    expect(fixture.archive.register).not.toHaveBeenCalled();
  });

  it('stops at an abort checkpoint without registering later descriptors', async () => {
    const controller = new AbortController();
    const candidate = candidateFor(1);
    const handle = traversal({
      nextCandidate: vi.fn(async () => {
        controller.abort(new DOMException('shutdown', 'AbortError'));
        return { candidate, visitedEntries: 1, complete: false };
      }),
    });
    const fixture = useCaseFixture({ traversal: handle });

    await expect(fixture.subject.reconcileBatch(
      handle,
      DEFAULT_OPTIONS,
      controller.signal,
    )).rejects.toMatchObject({ name: 'AbortError' });

    expect(handle.continueHash).not.toHaveBeenCalled();
    expect(fixture.archive.register).not.toHaveBeenCalled();
  });
});

function candidateFor(index: number): CompletedMotionVideoCandidate {
  const suffix = String(index).padStart(6, '0');
  return {
    sourceIdentity: `motion:2026/08/29/123456-${suffix}.mp4`,
    trustedPath: `/motion/2026/08/29/123456-${suffix}.mp4`,
    relativePath: `2026/08/29/123456-${suffix}.mp4`,
    size: 42,
    mtimeNs: `${1_787_992_496_000_000_000n + BigInt(index)}`,
    sourceTimeMs: 1_787_992_496_000,
  };
}

function descriptorFor(candidate: CompletedMotionVideoCandidate): CompletedMotionVideoDescriptor {
  return {
    kind: 'motion_video',
    ...candidate,
    sha256: candidate.sourceIdentity.padEnd(64, 'a').slice(0, 64),
    sourceFingerprint: candidate.sourceIdentity.padEnd(64, 'b').slice(0, 64),
  };
}

function motionEvent(id: number, videoPath = candidateFor(id).trustedPath): MotionEvent {
  return {
    id,
    cameraId: 'front',
    startedAt: new Date(1_787_992_496_000),
    endedAt: new Date(1_787_992_496_000),
    videoPath,
    snapshotPath: null,
    archiveArtifactId: null,
    archiveWebViewLink: null,
    uploadedToGdrive: false,
    gdriveFileId: null,
    localDeleted: false,
  };
}

function traversal(
  overrides: Partial<CompletedMotionVideoTraversal> = {},
): CompletedMotionVideoTraversal {
  return {
    pendingCandidate: vi.fn(() => null),
    inspect: vi.fn(async () => null),
    nextCandidate: vi.fn(async () => ({ candidate: null, visitedEntries: 0, complete: true })),
    continueHash: vi.fn(async () => ({ kind: 'rejected' as const, hashedBytes: 0 })),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

function mutableClock(startMs = 0) {
  const clock = { nowMs: startMs, now: () => clock.nowMs };
  return clock;
}

function useCaseFixture(input: {
  events?: MotionEvent[];
  traversal?: CompletedMotionVideoTraversal;
  knownArtifactId?: string;
  clock?: { now(): number };
  options?: typeof DEFAULT_OPTIONS;
  archiveRegister?: ArchiveRegistrationPort['register'];
  onAttach?: (eventIds: readonly number[]) => void;
} = {}) {
  const rows = (input.events ?? []).map((event) => ({ ...event }));
  let createdId = Math.max(0, ...rows.map(({ id }) => id));
  const repository = {
    findEventById: vi.fn(async (id: number) => rows.find((event) => event.id === id) ?? null),
    findUnarchivedCompletedVideos: vi.fn(async (limit: number) => rows
      .filter((event) => event.endedAt !== null && event.videoPath !== null && event.archiveArtifactId === null)
      .slice(0, limit)),
    findCompletedEventsByVideoPath: vi.fn(async (path: string) => rows
      .filter((event) => event.endedAt !== null
        && event.videoPath === path
        && event.archiveArtifactId === null)),
    createCompletedEvent: vi.fn(async (
      cameraId: string | null,
      startedAt: Date,
      endedAt: Date,
      videoPath: string,
    ) => {
      const created = motionEvent(++createdId, videoPath);
      created.cameraId = cameraId;
      created.startedAt = startedAt;
      created.endedAt = endedAt;
      rows.push(created);
      return created;
    }),
    attachArchiveArtifact: vi.fn(async (eventIds: number[], artifactId: string) => {
      input.onAttach?.(eventIds);
      for (const row of rows) {
        if (eventIds.includes(row.id) && row.archiveArtifactId === null) {
          row.archiveArtifactId = artifactId;
        }
      }
    }),
    deferArchiveRegistration: vi.fn(async () => undefined),
  };
  const handle = input.traversal ?? traversal();
  const completedVideos: CompletedMotionVideoPort = {
    resolve: vi.fn(async () => null),
    openTraversal: vi.fn(async () => handle),
  };
  let artifactId = 0;
  const archive: ArchiveRegistrationPort = {
    register: vi.fn(input.archiveRegister ?? (async () => ({ id: `artifact-${++artifactId}` }) as never)),
  };
  const lookup: ArchiveRegistrationLookupPort = {
    findKnown: vi.fn(async () => input.knownArtifactId === undefined
      ? null
      : { artifactId: input.knownArtifactId }),
  };
  const clock = input.clock ?? mutableClock();
  const subject = new RegisterCompletedMotionVideosUseCase(
    repository,
    completedVideos,
    archive,
    lookup,
    clock,
    INSTALLATION_ID,
    repository,
  );
  return {
    subject,
    repository,
    completedVideos,
    archive: archive as ArchiveRegistrationPort & { register: ReturnType<typeof vi.fn> },
    lookup: lookup as ArchiveRegistrationLookupPort & { findKnown: ReturnType<typeof vi.fn> },
    clock,
    options: input.options ?? DEFAULT_OPTIONS,
  };
}
