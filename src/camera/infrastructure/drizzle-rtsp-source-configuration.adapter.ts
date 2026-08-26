import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { AppDatabase, DB } from '../../database/database.module';
import {
  cameraLiveCredentials,
  cameraLiveSources,
  cameras,
} from '../../database/schema';
import { cameraNameKey } from '../domain/camera-name-key';
import type { LiveSource } from '../domain/live-source.entity';
import { CameraIdCollisionError } from '../domain/errors/camera-id-collision.error';
import { CameraNameTakenError } from '../domain/errors/camera-name-taken.error';
import { InvalidLiveSourceError } from '../domain/errors/invalid-live-source.error';
import { LiveSourceStateChangedError } from '../domain/errors/live-source-state-changed.error';
import type { RedactedLiveSource } from '../domain/ports/live-source-repository.port';
import type {
  PersistVerifiedSource,
  RtspSourceConfigurationPort,
} from '../domain/ports/rtsp-source-configuration.port';

/**
 * `cameras.type` of a row that exists only to carry an RTSP source, and is
 * therefore removed with it. Read inside the removal transaction — never taken
 * from the caller.
 */
const RTSP_CAMERA_TYPE = 'rtsp';

const CAMERA_ID_CONSTRAINT = 'cameras.id';
/** Both indexes guard one logical name; an exact clash implies a key clash. */
const CAMERA_NAME_CONSTRAINTS = new Set(['cameras.name', 'cameras.name_key']);
const LIVE_SOURCE_KEY_CONSTRAINT = 'camera_live_sources.camera_id';

/**
 * Every mutation is one synchronous better-sqlite3 transaction, so the caller's
 * final authorization, gate, and policy checks stay adjacent to the write with
 * no await between them. Encryption, probing, DNS, and authorization all happen
 * before the call; this adapter only commits the result.
 */
@Injectable()
export class DrizzleRtspSourceConfigurationAdapter
  implements RtspSourceConfigurationPort
{
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  createCamera(
    input: PersistVerifiedSource & {
      camera: { id: string; name: string; nameKey: string };
    },
  ): RedactedLiveSource {
    const { camera, source } = input;
    assertSourceAddresses(source, camera.id);
    // The key decides uniqueness, so a caller-supplied one is checked rather
    // than trusted: a mismatched key would claim the wrong slot in the index.
    if (camera.nameKey !== cameraNameKey(camera.name)) {
      throw new InvalidLiveSourceError('camera name key is not canonical');
    }
    const now = Date.now();

    try {
      return this.db.transaction((tx) => {
        tx.insert(cameras)
          .values({
            id: camera.id,
            name: camera.name,
            nameKey: camera.nameKey,
            type: RTSP_CAMERA_TYPE,
            config: null,
            enabled: true,
          })
          .run();
        tx.insert(cameraLiveSources)
          .values(freshSourceRow(input, camera.id, now))
          .run();
        tx.insert(cameraLiveCredentials)
          .values({ cameraId: camera.id, ...input.credential })
          .run();
        return redacted(input, camera.name, 0);
      });
    } catch (error) {
      const constraint = violatedConstraint(error);
      if (constraint === CAMERA_ID_CONSTRAINT) throw new CameraIdCollisionError();
      if (constraint !== null && CAMERA_NAME_CONSTRAINTS.has(constraint)) {
        throw new CameraNameTakenError();
      }
      throw error;
    }
  }

  attach(input: PersistVerifiedSource & { cameraId: string }): RedactedLiveSource {
    assertSourceAddresses(input.source, input.cameraId);
    const now = Date.now();

    try {
      return this.db.transaction((tx) => {
        const camera = tx
          .select({ name: cameras.name })
          .from(cameras)
          .where(eq(cameras.id, input.cameraId))
          .get();
        if (!camera) throw new LiveSourceStateChangedError();
        // A plain insert, not an upsert: the source primary key is the
        // attach/attach authority, so the loser of a race is told to re-read.
        tx.insert(cameraLiveSources)
          .values(freshSourceRow(input, input.cameraId, now))
          .run();
        tx.insert(cameraLiveCredentials)
          .values({ cameraId: input.cameraId, ...input.credential })
          .run();
        return redacted(input, camera.name, 0);
      });
    } catch (error) {
      if (violatedConstraint(error) === LIVE_SOURCE_KEY_CONSTRAINT) {
        throw new LiveSourceStateChangedError();
      }
      throw error;
    }
  }

  replace(
    input: PersistVerifiedSource & { cameraId: string; expectedRevision: number },
  ): RedactedLiveSource {
    assertSourceAddresses(input.source, input.cameraId);
    const revision = input.expectedRevision + 1;
    const now = Date.now();

    return this.db.transaction((tx) => {
      const swapped = tx
        .update(cameraLiveSources)
        .set({
          normalizedUrl: input.source.normalizedUrl,
          settings: input.source.settings,
          ready: input.source.ready,
          updatedAt: now,
          revision,
          verifiedAt: input.verifiedAt.getTime(),
          policyDigest: input.policyDigest,
        })
        .where(
          and(
            eq(cameraLiveSources.cameraId, input.cameraId),
            eq(cameraLiveSources.revision, input.expectedRevision),
          ),
        )
        .run();
      if (swapped.changes === 0) throw new LiveSourceStateChangedError();

      tx.insert(cameraLiveCredentials)
        .values({ cameraId: input.cameraId, ...input.credential })
        .onConflictDoUpdate({
          target: cameraLiveCredentials.cameraId,
          set: input.credential,
        })
        .run();
      const camera = tx
        .select({ name: cameras.name })
        .from(cameras)
        .where(eq(cameras.id, input.cameraId))
        .get();
      if (!camera) throw new LiveSourceStateChangedError();
      return redacted(input, camera.name, revision);
    });
  }

  remove(input: { cameraId: string; expectedRevision: number }): {
    removed: 'camera' | 'source';
  } {
    return this.db.transaction((tx) => {
      // The stored type — read here, inside the swap — decides how far the
      // removal reaches. No caller-supplied decision is accepted.
      const camera = tx
        .select({ type: cameras.type })
        .from(cameras)
        .where(eq(cameras.id, input.cameraId))
        .get();
      if (!camera) throw new LiveSourceStateChangedError();

      const retired = tx
        .delete(cameraLiveSources)
        .where(
          and(
            eq(cameraLiveSources.cameraId, input.cameraId),
            eq(cameraLiveSources.revision, input.expectedRevision),
          ),
        )
        .run();
      if (retired.changes === 0) throw new LiveSourceStateChangedError();
      // Redundant while foreign keys cascade, and correct if they ever do not.
      tx.delete(cameraLiveCredentials)
        .where(eq(cameraLiveCredentials.cameraId, input.cameraId))
        .run();

      if (camera.type !== RTSP_CAMERA_TYPE) return { removed: 'source' as const };
      tx.delete(cameras).where(eq(cameras.id, input.cameraId)).run();
      return { removed: 'camera' as const };
    });
  }
}

function freshSourceRow(
  input: PersistVerifiedSource,
  cameraId: string,
  now: number,
): typeof cameraLiveSources.$inferInsert {
  return {
    cameraId,
    normalizedUrl: input.source.normalizedUrl,
    settings: input.source.settings,
    ready: input.source.ready,
    createdAt: now,
    updatedAt: now,
    revision: 0,
    // Epoch milliseconds, matching `createdAt`/`updatedAt` in the same row.
    verifiedAt: input.verifiedAt.getTime(),
    policyDigest: input.policyDigest,
  };
}

/**
 * Credential-free projection of what was just committed. `summary()` exposes
 * the host alone, so no userinfo or path ever reaches a caller.
 */
function redacted(
  input: PersistVerifiedSource,
  cameraName: string,
  revision: number,
): RedactedLiveSource {
  return {
    cameraId: input.source.cameraId,
    cameraName,
    summary: input.source.summary(),
    hasCredential: true,
    revision,
    verifiedAt: new Date(input.verifiedAt.getTime()),
    policyDigest: input.policyDigest,
  };
}

function assertSourceAddresses(source: LiveSource, cameraId: string): void {
  if (source.cameraId !== cameraId) {
    throw new InvalidLiveSourceError('source is addressed to a different camera');
  }
}

/**
 * The columns better-sqlite3 names in a violated uniqueness constraint, or
 * `null` for anything else — an unrelated failure must stay unmapped.
 */
function violatedConstraint(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code !== 'string' || !code.startsWith('SQLITE_CONSTRAINT_')) return null;
  if (typeof message !== 'string') return null;
  const match = /(?:UNIQUE|PRIMARY KEY) constraint failed: (.+)$/u.exec(message);
  return match?.[1] ?? null;
}
