import { Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { AppDatabase, DB } from '../../database/database.module';
import {
  cameraLiveCredentials,
  cameraLiveSources,
  cameras,
} from '../../database/schema';
import { LiveSource } from '../domain/live-source.entity';
import { InvalidLiveSourceError } from '../domain/errors/invalid-live-source.error';
import { LiveSourceCredentialUnavailableError } from '../domain/errors/live-source-credential-unavailable.error';
import {
  LIVE_SOURCE_CREDENTIAL,
  type LiveSourceCredentialPort,
} from '../domain/ports/live-source-credential.port';
import type {
  EncryptedLiveSourceCredential,
  LiveSourceForStream,
  LiveSourceRepositoryPort,
  RedactedLiveSource,
} from '../domain/ports/live-source-repository.port';

@Injectable()
export class DrizzleLiveSourceRepository implements LiveSourceRepositoryPort {
  #credentialWritesEnabled = false;

  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(LIVE_SOURCE_CREDENTIAL)
    private readonly credentials: LiveSourceCredentialPort,
  ) {}

  async save(
    source: LiveSource,
    credential: EncryptedLiveSourceCredential | null,
  ): Promise<void> {
    if (credential && !this.#credentialWritesEnabled) {
      throw new LiveSourceCredentialUnavailableError();
    }
    const now = Date.now();
    this.db.transaction((tx) => {
      tx.insert(cameraLiveSources)
        .values({
          cameraId: source.cameraId,
          normalizedUrl: source.normalizedUrl,
          settings: source.settings,
          ready: source.ready,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: cameraLiveSources.cameraId,
          set: {
            normalizedUrl: source.normalizedUrl,
            settings: source.settings,
            ready: source.ready,
            updatedAt: now,
          },
        })
        .run();

      if (credential === null) {
        tx.delete(cameraLiveCredentials)
          .where(eq(cameraLiveCredentials.cameraId, source.cameraId))
          .run();
        return;
      }
      tx.insert(cameraLiveCredentials)
        .values({ cameraId: source.cameraId, ...credential })
        .onConflictDoUpdate({
          target: cameraLiveCredentials.cameraId,
          set: credential,
        })
        .run();
    });
  }

  async loadForStream(cameraId: string): Promise<LiveSourceForStream | null> {
    const row = this.db
      .select({
        cameraId: cameraLiveSources.cameraId,
        normalizedUrl: cameraLiveSources.normalizedUrl,
        settings: cameraLiveSources.settings,
        ready: cameraLiveSources.ready,
        ciphertext: cameraLiveCredentials.ciphertext,
        nonce: cameraLiveCredentials.nonce,
        authTag: cameraLiveCredentials.authTag,
        keyVersion: cameraLiveCredentials.keyVersion,
      })
      .from(cameraLiveSources)
      .innerJoin(
        cameraLiveCredentials,
        eq(cameraLiveCredentials.cameraId, cameraLiveSources.cameraId),
      )
      .where(eq(cameraLiveSources.cameraId, cameraId))
      .get();
    if (!row?.ready) return null;
    const credential = this.credentials.decrypt(cameraId, {
      ciphertext: row.ciphertext,
      nonce: row.nonce,
      authTag: row.authTag,
      keyVersion: row.keyVersion,
    });
    return {
      source: LiveSource.restore({
        cameraId: row.cameraId,
        normalizedUrl: row.normalizedUrl,
        settings: row.settings,
        ready: row.ready,
        credentialPayload: credential,
      }),
      credential,
    };
  }

  async isReady(cameraId: string): Promise<boolean> {
    const row = this.db.select({ ready: cameraLiveSources.ready })
      .from(cameraLiveSources)
      .innerJoin(cameraLiveCredentials, eq(cameraLiveCredentials.cameraId, cameraLiveSources.cameraId))
      .where(eq(cameraLiveSources.cameraId, cameraId))
      .get();
    return row?.ready === true;
  }

  async saveMetadataBatch(sources: readonly LiveSource[]): Promise<void> {
    const now = Date.now();
    this.db.transaction((tx) => {
      for (const source of sources) {
        if (source.ready) {
          throw new InvalidLiveSourceError('metadata import source must not be ready');
        }
        tx.insert(cameraLiveSources)
          .values({
            cameraId: source.cameraId,
            normalizedUrl: source.normalizedUrl,
            settings: source.settings,
            ready: false,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: cameraLiveSources.cameraId,
            set: {
              normalizedUrl: source.normalizedUrl,
              settings: source.settings,
              ready: false,
              updatedAt: now,
            },
          })
          .run();
        tx.delete(cameraLiveCredentials)
          .where(eq(cameraLiveCredentials.cameraId, source.cameraId))
          .run();
      }
    });
  }

  async listRedacted(): Promise<RedactedLiveSource[]> {
    return this.db
      .select({
        cameraId: cameraLiveSources.cameraId,
        cameraName: cameras.name,
        normalizedUrl: cameraLiveSources.normalizedUrl,
        settings: cameraLiveSources.settings,
        ready: cameraLiveSources.ready,
      })
      .from(cameraLiveSources)
      .innerJoin(cameras, eq(cameras.id, cameraLiveSources.cameraId))
      .orderBy(asc(cameras.name))
      .all()
      .map((row) => ({
        cameraId: row.cameraId,
        cameraName: row.cameraName,
        summary: {
          scheme: row.settings.scheme,
          host: new URL(row.normalizedUrl).host,
          transport: row.settings.transport,
          tlsMode: row.settings.tlsMode,
          profile: row.settings.profile,
          substreamHost: row.settings.substream
            ? new URL(row.settings.substream).host
            : null,
          ready: row.ready,
        },
      }));
  }

  async remove(cameraId: string): Promise<void> {
    this.db
      .delete(cameraLiveSources)
      .where(eq(cameraLiveSources.cameraId, cameraId))
      .run();
  }

  async rotate(): Promise<void> {
    this.#credentialWritesEnabled = false;
    this.db.transaction((tx) => {
      const rows = tx
        .select()
        .from(cameraLiveCredentials)
        .orderBy(asc(cameraLiveCredentials.cameraId))
        .all();
      for (const row of rows) {
        const plaintext = this.credentials.decrypt(row.cameraId, row);
        if (row.keyVersion === this.credentials.currentVersion()) continue;
        const rotated = this.credentials.encrypt(row.cameraId, plaintext);
        tx.update(cameraLiveCredentials)
          .set(rotated)
          .where(eq(cameraLiveCredentials.cameraId, row.cameraId))
          .run();
      }
    });
    this.#credentialWritesEnabled = true;
  }
}
