import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AttachRtspSourceUseCase } from '../../../src/camera/application/attach-rtsp-source.use-case';
import { CreateRtspCameraUseCase } from '../../../src/camera/application/create-rtsp-camera.use-case';
import { RemoveRtspSourceUseCase } from '../../../src/camera/application/remove-rtsp-source.use-case';
import { ReplaceRtspSourceUseCase } from '../../../src/camera/application/replace-rtsp-source.use-case';
import { RtspSourceMutationService } from '../../../src/camera/application/rtsp-source-mutation.service';
import { RtspSourceStartGate } from '../../../src/camera/application/rtsp-source-start-gate.service';
import { TestRtspSourceUseCase } from '../../../src/camera/application/test-rtsp-source.use-case';
import { CameraSourceAdminRequiredError } from '../../../src/camera/domain/errors/camera-source-admin-required.error';
import { CameraIdCollisionError } from '../../../src/camera/domain/errors/camera-id-collision.error';
import { CameraNameTakenError } from '../../../src/camera/domain/errors/camera-name-taken.error';
import { CameraSourceUnavailableError } from '../../../src/camera/domain/errors/camera-source-unavailable.error';
import { InvalidLiveSourceError } from '../../../src/camera/domain/errors/invalid-live-source.error';
import { LiveSourceAuthenticationRejectedError } from '../../../src/camera/domain/errors/live-source-authentication-rejected.error';
import { LiveSourceStateChangedError } from '../../../src/camera/domain/errors/live-source-state-changed.error';
import { liveSourceFrom } from '../../../src/camera/domain/live-source-factory';
import { LiveSource } from '../../../src/camera/domain/live-source.entity';
import type { CameraIdGeneratorPort } from '../../../src/camera/domain/ports/camera-id-generator.port';
import type { CameraSourceAuthorizationPort } from '../../../src/camera/domain/ports/camera-source-authorization.port';
import type { LiveSourceProbePort } from '../../../src/camera/domain/ports/live-source-probe.port';
import type { LiveSourceSessionControlPort } from '../../../src/camera/domain/ports/live-source-session-control.port';
import { AesGcmLiveSourceCredentialAdapter } from '../../../src/camera/infrastructure/aes-gcm-live-source-credential.adapter';
import { InMemoryLiveSourceRepository } from '../../../src/camera/infrastructure/in-memory-live-source.repository';
import { InMemoryMediaRepository } from '../../../src/camera/infrastructure/in-memory-media.repository';
import { InMemoryRtspSourceConfigurationAdapter } from '../../../src/camera/infrastructure/in-memory-rtsp-source-configuration.adapter';
import { FeatureUnavailableError } from '../../../src/features/domain/errors/feature-unavailable.error';
import { RtspPolicyDigestMismatchError } from '../../../src/features/domain/errors/rtsp-policy-digest-mismatch.error';
import { RtspPolicyUnavailableError } from '../../../src/features/domain/errors/rtsp-policy-unavailable.error';
import type { FeatureAvailabilityPort } from '../../../src/features/domain/ports/feature-availability.port';
import type { RtspPolicyStatusPort } from '../../../src/features/domain/ports/rtsp-policy-status.port';

const SECRET_URL = 'rtsp://operator:hunter2@cam.local/stream1?token=abcdef';
const SECRETS = /operator|hunter2|stream1|token|abcdef/iu;
const DIGEST = 'digest-1';
const VERIFIED_AT = new Date('2026-08-26T10:00:00.000Z');

function sourceInput(overrides: Record<string, unknown> = {}) {
  return {
    actorUserId: 7,
    url: SECRET_URL,
    transport: 'tcp' as const,
    tlsMode: 'none' as const,
    profile: 'eco' as const,
    ...overrides,
  };
}

async function fixture() {
  const credentials = new AesGcmLiveSourceCredentialAdapter({
    currentKey: '11'.repeat(32),
    currentVersion: 1,
  });
  const media = new InMemoryMediaRepository();
  media.seedCameras([
    { id: 'legacy-1', name: 'Hallway', type: 'motion', config: null, enabled: true },
    { id: 'legacy-2', name: 'Garage', type: 'motion', config: null, enabled: true },
  ]);
  const repository = new InMemoryLiveSourceRepository(credentials, async (cameraId) =>
    (await media.listCameras()).find((camera) => camera.id === cameraId)?.name ?? cameraId,
  );
  await repository.rotate();
  const configuration = new InMemoryRtspSourceConfigurationAdapter(media, repository);
  const gate = new RtspSourceStartGate(undefined, true);
  const authorization: CameraSourceAuthorizationPort = { requireAdmin: vi.fn() };
  const availability: FeatureAvailabilityPort = {
    awaitInitialVerification: vi.fn(),
    inspect: vi.fn(),
    requireReady: vi.fn().mockResolvedValue(undefined),
  };
  const policyStatus: RtspPolicyStatusPort = {
    inspect: vi.fn(),
    requireCurrent: vi.fn().mockResolvedValue({ digest: DIGEST, networks: [] }),
    assertDigest: vi.fn(),
  };
  const probe: LiveSourceProbePort = { run: vi.fn().mockResolvedValue(undefined) };
  const sessions: LiveSourceSessionControlPort = {
    stopCamera: vi.fn().mockResolvedValue(undefined),
    stopSourceKind: vi.fn().mockResolvedValue(undefined),
  };
  let minted = 0;
  const ids: CameraIdGeneratorPort = {
    generate: vi.fn(() => {
      minted += 1;
      return `minted-${minted}`;
    }),
  };
  const mutations = new RtspSourceMutationService(
    authorization,
    availability,
    policyStatus,
    probe,
    credentials,
    sessions,
    repository,
    { now: () => VERIFIED_AT },
    gate,
  );

  return {
    authorization,
    availability,
    configuration,
    credentials,
    gate,
    ids,
    media,
    mutations,
    policyStatus,
    probe,
    repository,
    sessions,
    create: new CreateRtspCameraUseCase(mutations, configuration, ids),
    attach: new AttachRtspSourceUseCase(mutations, configuration),
    replace: new ReplaceRtspSourceUseCase(mutations, configuration),
    remove: new RemoveRtspSourceUseCase(mutations, configuration),
    test: new TestRtspSourceUseCase(mutations),
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Every credential-free fact a precommit failure must leave untouched. */
function snapshot(subject: Fixture): string {
  return JSON.stringify({
    cameras: subject.media.allCameras(),
    sources: subject.repository.listStoredSources(),
  });
}

async function seedSource(subject: Fixture, cameraId: string): Promise<void> {
  await subject.attach.execute({ ...sourceInput(), cameraId });
  vi.mocked(subject.probe.run).mockClear();
  vi.mocked(subject.sessions.stopCamera).mockClear();
  vi.mocked(subject.availability.requireReady).mockClear();
  vi.mocked(subject.policyStatus.requireCurrent).mockClear();
  vi.mocked(subject.policyStatus.assertDigest).mockClear();
  vi.mocked(subject.authorization.requireAdmin).mockClear();
}

describe('RTSP source mutations', () => {
  let subject: Fixture;

  beforeEach(async () => {
    subject = await fixture();
  });

  describe('create', () => {
    it('mints a camera, probes the credentialed source and stores the attestation', async () => {
      const result = await subject.create.execute({
        ...sourceInput(),
        displayName: 'Back Door',
      });

      expect(result).toMatchObject({
        cameraId: 'minted-1',
        cameraName: 'Back Door',
        hasCredential: true,
        revision: 0,
        verifiedAt: VERIFIED_AT,
        policyDigest: DIGEST,
      });
      // The probe sees the plaintext; nothing that leaves the use case does.
      const probed = vi.mocked(subject.probe.run).mock.calls[0][0];
      expect(probed.credentialPayload().primaryUrl).toBe(SECRET_URL);
      expect(JSON.stringify(result)).not.toMatch(SECRETS);
      expect(subject.media.allCameras()).toContainEqual(
        expect.objectContaining({ id: 'minted-1', name: 'Back Door', type: 'rtsp-source' }),
      );
      await expect(subject.repository.loadForStream('minted-1')).resolves.toMatchObject({
        credential: { primaryUrl: SECRET_URL },
      });
      expect(subject.sessions.stopCamera).not.toHaveBeenCalled();
    });

    it.each([
      ['blank', '   '],
      ['control-bearing', 'Back\u0007Door'],
      ['over-long', 'x'.repeat(65)],
    ])('rejects a %s display name before minting an identifier', async (_label, displayName) => {
      const before = snapshot(subject);

      await expect(
        subject.create.execute({ ...sourceInput(), displayName }),
      ).rejects.toBeInstanceOf(InvalidLiveSourceError);
      expect(subject.ids.generate).not.toHaveBeenCalled();
      expect(snapshot(subject)).toBe(before);
    });

    it('refuses a duplicate name and a colliding identifier without writing', async () => {
      const before = snapshot(subject);

      await expect(
        subject.create.execute({ ...sourceInput(), displayName: '  hallway  ' }),
      ).rejects.toBeInstanceOf(CameraNameTakenError);
      expect(snapshot(subject)).toBe(before);

      vi.mocked(subject.ids.generate).mockReturnValue('legacy-1');
      await expect(
        subject.create.execute({ ...sourceInput(), displayName: 'Back Door' }),
      ).rejects.toBeInstanceOf(CameraIdCollisionError);
      expect(snapshot(subject)).toBe(before);
    });
  });

  describe('attach', () => {
    it('gives an existing camera its first source', async () => {
      const result = await subject.attach.execute({ ...sourceInput(), cameraId: 'legacy-1' });

      expect(result).toMatchObject({
        cameraId: 'legacy-1',
        cameraName: 'Hallway',
        revision: 0,
        verifiedAt: VERIFIED_AT,
        policyDigest: DIGEST,
      });
      expect(subject.media.allCameras()).toContainEqual(
        expect.objectContaining({ id: 'legacy-1', type: 'motion' }),
      );
      expect(subject.sessions.stopCamera).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toMatch(SECRETS);
    });

    it('refuses a camera that already has a source, leaving the stored one intact', async () => {
      await seedSource(subject, 'legacy-1');
      const before = snapshot(subject);

      await expect(
        subject.attach.execute({
          ...sourceInput({ url: 'rtsp://other:pw@replacement.local/live' }),
          cameraId: 'legacy-1',
        }),
      ).rejects.toBeInstanceOf(LiveSourceStateChangedError);
      expect(snapshot(subject)).toBe(before);
    });

    // Imported metadata occupies the source primary key without a credential,
    // so attaching over it is a state change and re-crediting it is a replace.
    it('refuses a camera whose source came from a credential-free import', async () => {
      await subject.repository.save(
        LiveSource.create({ cameraId: 'legacy-1', url: 'rtsp://cam.local/live', ready: false }),
        null,
      );
      const before = snapshot(subject);

      await expect(
        subject.attach.execute({ ...sourceInput(), cameraId: 'legacy-1' }),
      ).rejects.toBeInstanceOf(LiveSourceStateChangedError);
      expect(snapshot(subject)).toBe(before);

      await expect(
        subject.replace.execute({ ...sourceInput(), cameraId: 'legacy-1', expectedRevision: 0 }),
      ).resolves.toMatchObject({ revision: 1, hasCredential: true });
    });
  });

  describe('replace', () => {
    it('stops only the target camera before advancing the revision', async () => {
      await seedSource(subject, 'legacy-1');
      await seedSource(subject, 'legacy-2');
      const order: string[] = [];
      vi.mocked(subject.sessions.stopCamera).mockImplementation(async (cameraId) => {
        order.push(`stop:${cameraId}`);
      });
      vi.mocked(subject.probe.run).mockImplementation(async () => {
        order.push('probe');
      });
      vi.mocked(subject.availability.requireReady).mockImplementation(async () => {
        order.push('ready');
      });
      vi.mocked(subject.policyStatus.requireCurrent).mockImplementation(async () => {
        order.push('policy');
        return { digest: DIGEST, networks: [] };
      });
      const commit = InMemoryRtspSourceConfigurationAdapter.prototype.replace;
      vi.spyOn(subject.configuration, 'replace').mockImplementation((input) => {
        order.push('commit');
        return commit.call(subject.configuration, input);
      });

      const result = await subject.replace.execute({
        ...sourceInput({ url: 'rtsp://other:pw@replacement.local/live' }),
        cameraId: 'legacy-1',
        expectedRevision: 0,
      });

      // The stop is the LAST await before the fence. Any await after it is a
      // window in which a user-initiated open can start a converter on the old
      // URL — a start that moves no gate epoch, so no fence below would see it.
      expect(order).toEqual([
        'ready',
        'policy',
        'probe',
        'ready',
        'policy',
        'stop:legacy-1',
        'commit',
      ]);
      expect(result).toMatchObject({ revision: 1, cameraName: 'Hallway' });
      expect(result.summary.host).toBe('replacement.local');
      // The other camera was never stopped and still holds its own source.
      expect(subject.sessions.stopCamera).toHaveBeenCalledTimes(1);
      expect(
        subject.repository.listStoredSources().find((row) => row.cameraId === 'legacy-2'),
      ).toMatchObject({ revision: 0, summary: { host: 'cam.local' } });
    });

    it('rejects a stale expected revision without touching the stored source', async () => {
      await seedSource(subject, 'legacy-1');
      const before = snapshot(subject);

      await expect(
        subject.replace.execute({ ...sourceInput(), cameraId: 'legacy-1', expectedRevision: 4 }),
      ).rejects.toBeInstanceOf(LiveSourceStateChangedError);
      expect(snapshot(subject)).toBe(before);
      expect(subject.sessions.stopCamera).not.toHaveBeenCalled();
      expect(subject.probe.run).not.toHaveBeenCalled();
    });

    it('keeps the old source and credential when the transaction loses the swap', async () => {
      await seedSource(subject, 'legacy-1');
      const before = snapshot(subject);
      vi.spyOn(subject.configuration, 'replace').mockImplementation(() => {
        throw new LiveSourceStateChangedError();
      });

      await expect(
        subject.replace.execute({
          ...sourceInput({ url: 'rtsp://other:pw@replacement.local/live' }),
          cameraId: 'legacy-1',
          expectedRevision: 0,
        }),
      ).rejects.toBeInstanceOf(LiveSourceStateChangedError);

      expect(snapshot(subject)).toBe(before);
      await expect(subject.repository.loadForStream('legacy-1')).resolves.toMatchObject({
        credential: { primaryUrl: SECRET_URL },
      });
      // Stopped once, and nothing restarted it: the port offers no way to.
      expect(subject.sessions.stopCamera).toHaveBeenCalledTimes(1);
      expect(subject.sessions.stopCamera).toHaveBeenCalledWith('legacy-1');
      expect(subject.sessions.stopSourceKind).not.toHaveBeenCalled();
    });

    it('reports a stop failure as a mutation failure, not a stream failure', async () => {
      await seedSource(subject, 'legacy-1');
      const before = snapshot(subject);
      vi.mocked(subject.sessions.stopCamera).mockRejectedValueOnce(new Error('busy'));

      const failure = await subject.replace
        .execute({ ...sourceInput(), cameraId: 'legacy-1', expectedRevision: 0 })
        .then(() => null, (error: unknown) => error);

      expect(failure).toBeInstanceOf(CameraSourceUnavailableError);
      expect(failure).toMatchObject({ reason: 'session-stop-failed' });
      expect(snapshot(subject)).toBe(before);
    });
  });

  describe('remove', () => {
    it('retires a minted camera outright and a pre-existing camera only of its source', async () => {
      const minted = await subject.create.execute({
        ...sourceInput(),
        displayName: 'Back Door',
      });
      await seedSource(subject, 'legacy-1');

      await expect(
        subject.remove.execute({ actorUserId: 7, cameraId: minted.cameraId, expectedRevision: 0 }),
      ).resolves.toEqual({ removed: 'camera' });
      expect(subject.media.allCameras().map((camera) => camera.id)).not.toContain('minted-1');

      await expect(
        subject.remove.execute({ actorUserId: 7, cameraId: 'legacy-1', expectedRevision: 0 }),
      ).resolves.toEqual({ removed: 'source' });
      expect(subject.media.allCameras().map((camera) => camera.id)).toContain('legacy-1');
      expect(subject.repository.listStoredSources()).toEqual([]);
      expect(subject.sessions.stopCamera).toHaveBeenCalledWith('legacy-1');
      expect(subject.probe.run).not.toHaveBeenCalled();
    });

    it('keeps the stored source when the transaction loses the swap', async () => {
      await seedSource(subject, 'legacy-1');
      const before = snapshot(subject);
      vi.spyOn(subject.configuration, 'remove').mockImplementation(() => {
        throw new LiveSourceStateChangedError();
      });

      await expect(
        subject.remove.execute({ actorUserId: 7, cameraId: 'legacy-1', expectedRevision: 0 }),
      ).rejects.toBeInstanceOf(LiveSourceStateChangedError);

      expect(snapshot(subject)).toBe(before);
      await expect(subject.repository.loadForStream('legacy-1')).resolves.toMatchObject({
        credential: { primaryUrl: SECRET_URL },
      });
      expect(subject.sessions.stopCamera).toHaveBeenCalledTimes(1);
      expect(subject.sessions.stopCamera).toHaveBeenCalledWith('legacy-1');
    });

    it('reports a stop failure without removing anything', async () => {
      await seedSource(subject, 'legacy-1');
      const before = snapshot(subject);
      vi.mocked(subject.sessions.stopCamera).mockRejectedValueOnce(new Error('busy'));

      await expect(
        subject.remove.execute({ actorUserId: 7, cameraId: 'legacy-1', expectedRevision: 0 }),
      ).rejects.toMatchObject({ reason: 'session-stop-failed' });
      expect(snapshot(subject)).toBe(before);
    });
  });

  describe('test', () => {
    it('probes the exact stored credential and changes nothing at all', async () => {
      await seedSource(subject, 'legacy-1');
      const before = snapshot(subject);

      const result = await subject.test.execute({ actorUserId: 7, cameraId: 'legacy-1' });

      const probed = vi.mocked(subject.probe.run).mock.calls[0][0];
      expect(probed.credentialPayload().primaryUrl).toBe(SECRET_URL);
      expect(result).toMatchObject({
        cameraId: 'legacy-1',
        cameraName: 'Hallway',
        hasCredential: true,
        revision: 0,
        verifiedAt: VERIFIED_AT,
        policyDigest: DIGEST,
      });
      expect(JSON.stringify(result)).not.toMatch(SECRETS);
      expect(snapshot(subject)).toBe(before);
      expect(subject.sessions.stopCamera).not.toHaveBeenCalled();
    });

    it('surfaces the typed probe failure without a credential and without writing', async () => {
      await seedSource(subject, 'legacy-1');
      const before = snapshot(subject);
      vi.mocked(subject.probe.run).mockRejectedValueOnce(
        new LiveSourceAuthenticationRejectedError(),
      );

      const failure = await subject.test
        .execute({ actorUserId: 7, cameraId: 'legacy-1' })
        .then(() => null, (error: unknown) => error);

      expect(failure).toMatchObject({ code: 'LIVE_SOURCE_AUTHENTICATION_REJECTED' });
      expect(`${JSON.stringify(failure)} ${String(failure)}`).not.toMatch(SECRETS);
      expect(snapshot(subject)).toBe(before);
    });

    it('refuses a camera whose stored source carries no credential', async () => {
      // The config-import case: metadata occupies the row, nothing to probe.
      await subject.repository.save(
        LiveSource.create({ cameraId: 'legacy-1', url: 'rtsp://cam.local/live', ready: false }),
        null,
      );
      const before = snapshot(subject);

      await expect(
        subject.test.execute({ actorUserId: 7, cameraId: 'legacy-1' }),
      ).rejects.toMatchObject({ code: 'LIVE_SOURCE_CREDENTIAL_UNAVAILABLE' });
      expect(subject.probe.run).not.toHaveBeenCalled();
      expect(snapshot(subject)).toBe(before);
    });

    // `test` is absent from the fence table because it commits nothing; it is
    // still gated on the actor and on RTSP before it puts a probe on the wire.
    it('refuses a non-admin and a disabled feature before probing', async () => {
      await seedSource(subject, 'legacy-1');
      vi.mocked(subject.authorization.requireAdmin).mockImplementationOnce(() => {
        throw new CameraSourceAdminRequiredError();
      });

      await expect(
        subject.test.execute({ actorUserId: 7, cameraId: 'legacy-1' }),
      ).rejects.toBeInstanceOf(CameraSourceAdminRequiredError);
      expect(subject.probe.run).not.toHaveBeenCalled();

      vi.mocked(subject.availability.requireReady).mockRejectedValueOnce(
        new FeatureUnavailableError('rtsp', 'installed-off'),
      );

      await expect(
        subject.test.execute({ actorUserId: 7, cameraId: 'legacy-1' }),
      ).rejects.toBeInstanceOf(FeatureUnavailableError);
      expect(subject.probe.run).not.toHaveBeenCalled();
    });

    it('refuses a camera with no stored source', async () => {
      await expect(
        subject.test.execute({ actorUserId: 7, cameraId: 'legacy-1' }),
      ).rejects.toBeInstanceOf(LiveSourceStateChangedError);
      expect(subject.probe.run).not.toHaveBeenCalled();
    });
  });

  describe('precommit fences', () => {
    /** Each mutation, as a call that would otherwise succeed. */
    const operations = [
      {
        name: 'create',
        stops: false,
        seed: null,
        run: (s: Fixture) => s.create.execute({ ...sourceInput(), displayName: 'Back Door' }),
      },
      {
        name: 'attach',
        stops: false,
        seed: null,
        run: (s: Fixture) => s.attach.execute({ ...sourceInput(), cameraId: 'legacy-1' }),
      },
      {
        name: 'replace',
        stops: true,
        seed: 'legacy-2',
        run: (s: Fixture) =>
          s.replace.execute({ ...sourceInput(), cameraId: 'legacy-2', expectedRevision: 0 }),
      },
      {
        name: 'remove',
        stops: true,
        seed: 'legacy-2',
        run: (s: Fixture) =>
          s.remove.execute({ actorUserId: 7, cameraId: 'legacy-2', expectedRevision: 0 }),
      },
    ] as const;

    /** Removal carries a deliberately smaller fence; see the carve-out below. */
    const installOperations = operations.filter((operation) => operation.name !== 'remove');

    async function armed(operation: (typeof operations)[number]): Promise<string> {
      if (operation.seed) await seedSource(subject, operation.seed);
      return snapshot(subject);
    }

    it.each(operations)(
      '$name authorizes again immediately before the commit',
      async (operation) => {
        const before = await armed(operation);
        // Revoked after every pre-commit authorization has already passed, so
        // only the final fence can catch it.
        const revoke = async (): Promise<void> => {
          vi.mocked(subject.authorization.requireAdmin).mockImplementation(() => {
            throw new CameraSourceAdminRequiredError();
          });
        };
        if (operation.stops) vi.mocked(subject.sessions.stopCamera).mockImplementationOnce(revoke);
        else vi.mocked(subject.probe.run).mockImplementationOnce(revoke);

        await expect(operation.run(subject)).rejects.toBeInstanceOf(CameraSourceAdminRequiredError);
        expect(snapshot(subject)).toBe(before);
      },
    );

    it.each(installOperations)('$name aborts when RTSP is disabled mid-flight', async (operation) => {
      const before = await armed(operation);
      vi.mocked(subject.availability.requireReady)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new FeatureUnavailableError('rtsp', 'installed-off'));

      await expect(operation.run(subject)).rejects.toBeInstanceOf(FeatureUnavailableError);
      expect(snapshot(subject)).toBe(before);
    });

    it.each(installOperations)(
      '$name aborts when the policy digest is no longer current',
      async (operation) => {
        const before = await armed(operation);
        vi.mocked(subject.policyStatus.assertDigest).mockImplementationOnce(() => {
          throw new RtspPolicyDigestMismatchError(DIGEST);
        });

        await expect(operation.run(subject)).rejects.toBeInstanceOf(RtspPolicyDigestMismatchError);
        expect(snapshot(subject)).toBe(before);
      },
    );

    it.each(installOperations)(
      '$name aborts when the policy is reinstalled mid-flight',
      async (operation) => {
        const before = await armed(operation);
        vi.mocked(subject.policyStatus.requireCurrent)
          .mockResolvedValueOnce({ digest: DIGEST, networks: [] })
          .mockResolvedValueOnce({ digest: 'digest-2', networks: [] });

        await expect(operation.run(subject)).rejects.toBeInstanceOf(RtspPolicyDigestMismatchError);
        expect(snapshot(subject)).toBe(before);
      },
    );

    it.each(installOperations)('$name aborts when the start gate closes mid-flight', async (operation) => {
      const before = await armed(operation);
      const close = async (): Promise<void> => {
        subject.gate.close();
      };
      if (operation.stops) vi.mocked(subject.sessions.stopCamera).mockImplementationOnce(close);
      else vi.mocked(subject.probe.run).mockImplementationOnce(close);

      const failure = await operation.run(subject).then(() => null, (error: unknown) => error);

      expect(failure).toBeInstanceOf(CameraSourceUnavailableError);
      expect(failure).toMatchObject({ reason: 'rtsp-closed' });
      expect(snapshot(subject)).toBe(before);
    });

    it.each(operations)('$name aborts when the stored revision moved', async (operation) => {
      const before = await armed(operation);
      vi.spyOn(subject.repository, 'findRedacted').mockResolvedValueOnce({
        cameraId: 'whatever',
        cameraName: 'Whatever',
        summary: {
          scheme: 'rtsp',
          host: 'cam.local',
          transport: 'tcp',
          tlsMode: 'none',
          profile: 'eco',
          substreamHost: null,
          ready: true,
        },
        hasCredential: true,
        revision: 99,
        verifiedAt: null,
        policyDigest: null,
      });

      await expect(operation.run(subject)).rejects.toBeInstanceOf(LiveSourceStateChangedError);
      expect(snapshot(subject)).toBe(before);
      expect(subject.probe.run).not.toHaveBeenCalled();
      expect(subject.sessions.stopCamera).not.toHaveBeenCalled();
    });

    it.each(installOperations)(
      '$name aborts on a probe failure and on an encryption failure',
      async (operation) => {
        const before = await armed(operation);
        vi.mocked(subject.probe.run).mockRejectedValueOnce(
          new LiveSourceAuthenticationRejectedError(),
        );

        await expect(operation.run(subject)).rejects.toBeInstanceOf(
          LiveSourceAuthenticationRejectedError,
        );
        expect(snapshot(subject)).toBe(before);
        expect(subject.sessions.stopCamera).not.toHaveBeenCalled();

        vi.spyOn(subject.credentials, 'encrypt').mockImplementationOnce(() => {
          throw new Error('key unavailable');
        });

        await expect(operation.run(subject)).rejects.toThrow('key unavailable');
        expect(snapshot(subject)).toBe(before);
        expect(subject.sessions.stopCamera).not.toHaveBeenCalled();
      },
    );
  });

  /**
   * Removal probes nothing, encrypts nothing and stores no digest, so gating it
   * on RTSP would lock an admin out of cleaning up on exactly the network that
   * broke the policy. These are the positive counterparts of the fence table.
   */
  // The service owns this, rather than leaning on the adapter to catch it at
  // commit: the fences would already have stopped and CAS'd the wrong camera.
  it('refuses a plan whose source addresses a camera other than the fenced one', async () => {
    const before = snapshot(subject);
    const commit = vi.fn(() => ({ committed: true }));

    await expect(
      subject.mutations.install(
        {
          actorUserId: 7,
          cameraId: 'legacy-1',
          source: liveSourceFrom('legacy-2', sourceInput()),
          expectedRevision: null,
          stopSessions: true,
        },
        commit,
      ),
    ).rejects.toBeInstanceOf(InvalidLiveSourceError);

    expect(commit).not.toHaveBeenCalled();
    expect(subject.probe.run).not.toHaveBeenCalled();
    expect(subject.sessions.stopCamera).not.toHaveBeenCalled();

    expect(snapshot(subject)).toBe(before);
  });

  describe('the removal carve-out', () => {
    const conditions = [
      {
        name: 'RTSP readiness is unavailable',
        arm: (s: Fixture) =>
          vi.mocked(s.availability.requireReady).mockRejectedValue(
            new FeatureUnavailableError('rtsp', 'installed-off'),
          ),
      },
      {
        name: 'the installed policy is not current',
        arm: (s: Fixture) =>
          vi.mocked(s.policyStatus.requireCurrent).mockRejectedValue(
            new RtspPolicyUnavailableError('unavailable'),
          ),
      },
      {
        name: 'the policy digest no longer matches',
        arm: (s: Fixture) =>
          vi.mocked(s.policyStatus.assertDigest).mockImplementation(() => {
            throw new RtspPolicyDigestMismatchError(DIGEST);
          }),
      },
      { name: 'the start gate is shut', arm: (s: Fixture) => s.gate.close() },
    ] as const;

    it.each(conditions)('removes a source while $name', async (condition) => {
      await seedSource(subject, 'legacy-1');
      condition.arm(subject);

      await expect(
        subject.remove.execute({ actorUserId: 7, cameraId: 'legacy-1', expectedRevision: 0 }),
      ).resolves.toEqual({ removed: 'source' });
      expect(subject.repository.listStoredSources()).toEqual([]);
      // Not merely tolerated: never consulted at all.
      expect(subject.availability.requireReady).not.toHaveBeenCalled();
      expect(subject.policyStatus.requireCurrent).not.toHaveBeenCalled();
      expect(subject.policyStatus.assertDigest).not.toHaveBeenCalled();
    });

    it('removes with every RTSP gate shut at once', async () => {
      await seedSource(subject, 'legacy-1');
      for (const condition of conditions) condition.arm(subject);

      await expect(
        subject.remove.execute({ actorUserId: 7, cameraId: 'legacy-1', expectedRevision: 0 }),
      ).resolves.toEqual({ removed: 'source' });
      expect(subject.repository.listStoredSources()).toEqual([]);
    });

    // What the carve-out must NOT have dropped.
    it('still stops the camera, still authorizes twice and still enforces the CAS', async () => {
      await seedSource(subject, 'legacy-1');
      for (const condition of conditions) condition.arm(subject);
      const before = snapshot(subject);

      await expect(
        subject.remove.execute({ actorUserId: 7, cameraId: 'legacy-1', expectedRevision: 3 }),
      ).rejects.toBeInstanceOf(LiveSourceStateChangedError);
      expect(snapshot(subject)).toBe(before);
      expect(subject.sessions.stopCamera).not.toHaveBeenCalled();

      await subject.remove.execute({ actorUserId: 7, cameraId: 'legacy-1', expectedRevision: 0 });
      expect(subject.sessions.stopCamera).toHaveBeenCalledWith('legacy-1');
      expect(subject.authorization.requireAdmin).toHaveBeenCalledTimes(3);
    });
  });

  describe('the commit fence', () => {
    it('leaves no await between the final checks and the synchronous transaction', () => {
      const service = readFileSync(
        resolve('src/camera/application/rtsp-source-mutation.service.ts'),
        'utf8',
      );
      const tails = service.split('// FENCE: no await below this line.').slice(1);

      expect(tails).toHaveLength(2);
      for (const tail of tails) {
        const body = tail.slice(0, tail.indexOf('\n  }'));
        expect(body).toContain('commit(');
        expect(body).not.toMatch(/\bawait\b|\.then\(|\basync\b/u);
      }
    });
  });
});
