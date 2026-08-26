import { describe, expect, it, vi } from 'vitest';
import { GetRtspSourceOverviewUseCase } from '../../../src/camera/application/get-rtsp-source-overview.use-case';
import { LiveSource } from '../../../src/camera/domain/live-source.entity';
import type {
  LiveSourcePolicyEvaluatorPort,
  RtspSourcePolicyRelationship,
} from '../../../src/camera/domain/ports/live-source-policy-evaluator.port';
import { RTSP_SOURCE_CAMERA_TYPE } from '../../../src/camera/domain/ports/rtsp-source-configuration.port';
import { AesGcmLiveSourceCredentialAdapter } from '../../../src/camera/infrastructure/aes-gcm-live-source-credential.adapter';
import { InMemoryLiveSourceRepository } from '../../../src/camera/infrastructure/in-memory-live-source.repository';
import { InMemoryMediaRepository } from '../../../src/camera/infrastructure/in-memory-media.repository';
import type {
  RtspPolicyStatus,
  RtspPolicyStatusPort,
} from '../../../src/features/domain/ports/rtsp-policy-status.port';

const SECRET_URL = 'rtsp://operator:hunter2@192.168.1.9/stream1?token=abcdef';
const SECRETS = /operator|hunter2|stream1|token|abcdef/iu;
const DIGEST = 'digest-1';
const VERIFIED_AT = new Date('2026-08-26T10:00:00.000Z');
const NETWORKS = [{ family: 4 as const, cidr: '192.168.1.0/24', interface: 'eth0' }];

const READY_POLICY: RtspPolicyStatus = {
  state: 'ready',
  digest: DIGEST,
  networks: NETWORKS,
};

function fixture(
  options: {
    policy?: RtspPolicyStatus;
    relationship?: RtspSourcePolicyRelationship;
  } = {},
) {
  const credentials = new AesGcmLiveSourceCredentialAdapter({
    currentKey: '11'.repeat(32),
    currentVersion: 1,
  });
  const decrypt = vi.spyOn(credentials, 'decrypt');
  const media = new InMemoryMediaRepository();
  const repository = new InMemoryLiveSourceRepository(credentials);
  const loadForStream = vi.spyOn(repository, 'loadForStream');
  const policyStatus: RtspPolicyStatusPort = {
    inspect: vi.fn().mockResolvedValue(options.policy ?? READY_POLICY),
    requireCurrent: vi.fn().mockRejectedValue(new Error('requireCurrent must not be used')),
    assertDigest: vi.fn(() => {
      throw new Error('assertDigest must not be used');
    }),
  };
  const evaluator: LiveSourcePolicyEvaluatorPort = {
    evaluate: vi.fn().mockResolvedValue(options.relationship ?? 'allowed'),
  };

  const source = (
    input: { cameraId: string; url?: string; ready?: boolean } = { cameraId: 'cam-1' },
  ) =>
    LiveSource.create({
      cameraId: input.cameraId,
      url: input.url ?? SECRET_URL,
      transport: 'tcp',
      tlsMode: 'none',
      profile: 'eco',
      ready: input.ready ?? true,
    });

  const store = (input: {
    cameraId: string;
    cameraName: string;
    url?: string;
    ready?: boolean;
    verifiedAt?: Date | null;
    policyDigest?: string | null;
  }) => {
    const built = source(input);
    repository.putVerifiedSource({
      source: built,
      cameraName: input.cameraName,
      credential: credentials.encrypt(input.cameraId, {
        primaryUrl: input.url ?? SECRET_URL,
        substreamUrl: null,
      }),
      revision: 1,
      verifiedAt: (input.verifiedAt === undefined ? VERIFIED_AT : input.verifiedAt)!,
      policyDigest: (input.policyDigest === undefined ? DIGEST : input.policyDigest)!,
    });
  };

  return {
    credentials,
    decrypt,
    evaluator,
    loadForStream,
    media,
    policyStatus,
    repository,
    source,
    store,
    useCase: new GetRtspSourceOverviewUseCase(repository, media, policyStatus, evaluator),
  };
}

describe('GetRtspSourceOverviewUseCase', () => {
  it('projects a ready policy and its installed networks', async () => {
    const context = fixture();
    const page = await context.useCase.execute();

    expect(page.policy).toEqual({ state: 'ready', networks: NETWORKS });
  });

  it('renders the installed networks of a stale policy instead of throwing', async () => {
    const context = fixture({
      policy: { state: 'stale', digest: DIGEST, networks: NETWORKS },
    });
    context.store({ cameraId: 'cam-1', cameraName: 'Hallway' });

    const page = await context.useCase.execute();

    expect(page.policy).toEqual({ state: 'stale', networks: NETWORKS });
    expect(page.sources[0].currentPolicyDigest).toBeNull();
    expect(page.sources[0].needsReverification).toBe(true);
    expect(page.sources[0].operationalState).toBe('needs-attention');
    expect(context.policyStatus.requireCurrent).not.toHaveBeenCalled();
  });

  it('projects an unavailable policy as an empty network list', async () => {
    const context = fixture({
      policy: { state: 'unavailable', digest: null, networks: [] },
    });

    const page = await context.useCase.execute();

    expect(page.policy).toEqual({ state: 'unavailable', networks: [] });
  });

  it('marks a verified, in-policy, digest-matching source as configured-verified', async () => {
    const context = fixture();
    context.store({ cameraId: 'cam-1', cameraName: 'Hallway' });

    const page = await context.useCase.execute();

    expect(page.sources).toHaveLength(1);
    expect(page.sources[0]).toMatchObject({
      cameraId: 'cam-1',
      cameraName: 'Hallway',
      relationship: 'allowed',
      operationalState: 'configured-verified',
      currentPolicyDigest: DIGEST,
      needsReverification: false,
    });
    expect(context.evaluator.evaluate).toHaveBeenCalledWith('192.168.1.9', {
      networks: NETWORKS,
    });
  });

  it('never treats a persisted ready flag alone as verification', async () => {
    const context = fixture();
    context.store({ cameraId: 'cam-1', cameraName: 'Hallway', verifiedAt: null });

    const page = await context.useCase.execute();

    expect(page.sources[0].summary.ready).toBe(true);
    expect(page.sources[0].operationalState).toBe('needs-attention');
    expect(page.sources[0].needsReverification).toBe(true);
  });

  it('demands reverification when the stored digest no longer matches', async () => {
    const context = fixture();
    context.store({ cameraId: 'cam-1', cameraName: 'Hallway', policyDigest: 'digest-0' });

    const page = await context.useCase.execute();

    expect(page.sources[0]).toMatchObject({
      needsReverification: true,
      operationalState: 'needs-attention',
      currentPolicyDigest: DIGEST,
      policyDigest: 'digest-0',
    });
  });

  it('demands reverification when the source is no longer in policy', async () => {
    const context = fixture({ relationship: 'blocked' });
    context.store({ cameraId: 'cam-1', cameraName: 'Hallway' });

    const page = await context.useCase.execute();

    expect(page.sources[0]).toMatchObject({
      relationship: 'blocked',
      needsReverification: true,
      operationalState: 'needs-attention',
    });
  });

  it('reports an unresolvable host as needing attention', async () => {
    const context = fixture({ relationship: 'unresolved' });
    context.store({ cameraId: 'cam-1', cameraName: 'Hallway' });

    const page = await context.useCase.execute();

    expect(page.sources[0]).toMatchObject({
      relationship: 'unresolved',
      needsReverification: true,
      operationalState: 'needs-attention',
    });
  });

  it('puts a missing credential ahead of every other operational state', async () => {
    const context = fixture();
    await context.repository.saveMetadataBatch([
      context.source({ cameraId: 'cam-1', ready: false }),
    ]);

    const page = await context.useCase.execute();

    expect(page.sources[0]).toMatchObject({
      hasCredential: false,
      operationalState: 'credentials-required',
      needsReverification: true,
    });
    expect(page.sources[0].summary.ready).toBe(false);
  });

  it('reports a credentialed source whose stored metadata is not ready', async () => {
    const context = fixture();
    context.store({ cameraId: 'cam-1', cameraName: 'Hallway', ready: false });

    const page = await context.useCase.execute();

    expect(page.sources[0]).toMatchObject({
      hasCredential: true,
      operationalState: 'not-ready',
    });
  });

  it('offers every enabled, source-free operator camera as an attach candidate', async () => {
    const context = fixture();
    context.media.seedCameras([
      { id: 'cam-1', name: 'Hallway', type: 'motion', config: null, enabled: true },
      { id: 'cam-2', name: 'Garage', type: 'motion', config: null, enabled: true },
      { id: 'cam-3', name: 'Shed', type: 'motion', config: null, enabled: false },
      { id: 'cam-4', name: 'Ghost', type: RTSP_SOURCE_CAMERA_TYPE, config: null, enabled: true },
    ]);
    context.store({ cameraId: 'cam-1', cameraName: 'Hallway' });

    const page = await context.useCase.execute();

    expect(page.attachCandidates).toEqual([{ cameraId: 'cam-2', cameraName: 'Garage' }]);
  });

  it('paginates sources and evaluates only the requested page', async () => {
    const context = fixture();
    for (const index of [1, 2, 3, 4, 5]) {
      context.store({ cameraId: `cam-${index}`, cameraName: `Camera ${index}` });
    }

    const page = await context.useCase.execute({ page: 2, pageSize: 2 });

    expect(page).toMatchObject({ page: 2, pageCount: 3 });
    expect(page.sources.map((source) => source.cameraId)).toEqual(['cam-3', 'cam-4']);
    expect(context.evaluator.evaluate).toHaveBeenCalledTimes(2);
  });

  it('clamps an out-of-range page onto the last available one', async () => {
    const context = fixture();
    context.store({ cameraId: 'cam-1', cameraName: 'Hallway' });

    await expect(context.useCase.execute({ page: 99, pageSize: 1 })).resolves.toMatchObject({
      page: 1,
      pageCount: 1,
    });
    await expect(context.useCase.execute({ page: -4, pageSize: 1 })).resolves.toMatchObject({
      page: 1,
    });
  });

  it('reports one empty page when nothing is stored', async () => {
    const context = fixture();

    const page = await context.useCase.execute();

    expect(page).toMatchObject({ page: 1, pageCount: 1 });
    expect(page.sources).toEqual([]);
  });

  it('never loads a stream credential or decrypts anything', async () => {
    const context = fixture();
    context.store({ cameraId: 'cam-1', cameraName: 'Hallway' });

    await context.useCase.execute();

    expect(context.loadForStream).not.toHaveBeenCalled();
    expect(context.decrypt).not.toHaveBeenCalled();
  });

  it('keeps credentials out of the rendered page and of the evaluator call', async () => {
    const context = fixture();
    context.store({ cameraId: 'cam-1', cameraName: 'Hallway' });

    const page = await context.useCase.execute();

    expect(JSON.stringify(page)).not.toMatch(SECRETS);
    expect(JSON.stringify(vi.mocked(context.evaluator.evaluate).mock.calls)).not.toMatch(SECRETS);
  });
});
