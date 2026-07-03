import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { AppDatabase, DB } from '../../database/database.module';
import {
  cameras,
  events,
  features,
  inviteCodes,
  motionEvents,
  sensorLogs,
  sensors,
  users,
  userSensorMutes,
} from '../../database/schema';
import { SensorRegistryService } from './sensor-registry.service';

export interface DevStateYaml {
  sensors?: {
    id: string;
    name: string;
    type: string;
    config?: Record<string, unknown>;
    debounceMs?: number;
    severity?: string;
    enabled?: boolean;
  }[];
  cameras?: {
    id: string;
    name: string;
    type: string;
    config?: Record<string, unknown>;
    enabled?: boolean;
  }[];
  users?: {
    telegramId: number;
    name: string;
    role: string;
    muted?: boolean;
  }[];
  invite_codes?: {
    code: string;
    role: string;
    createdBy?: number;
  }[];
  features?: {
    name: string;
    enabled?: boolean;
    installed?: boolean;
    config?: Record<string, unknown>;
  }[];
}

export interface SeedResult {
  ok: boolean;
  sensors: number;
  cameras: number;
  users: number;
  inviteCodes: number;
  features: number;
  reset: boolean;
}

/**
 * Seeds or resets the full system development state (spec 26).
 *
 * Automatically populates sensors, cameras, telegram users, invite codes,
 * and features when running in dev mode (`NODE_ENV=development`) with an
 * empty database, or on demand when triggered via CLI/API.
 */
@Injectable()
export class DevSeederService implements OnModuleInit {
  private readonly logger = new Logger(DevSeederService.name);

  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    private readonly sensorRegistry: SensorRegistryService,
  ) {}

  async onModuleInit(): Promise<void> {
    const isDev =
      process.env.NODE_ENV === 'development' ||
      process.env.DEV_SEED_BOOT === 'true';
    if (!isDev) return;

    try {
      const existingSensors = await this.db.select().from(sensors);
      if (existingSensors.length > 0) {
        this.logger.log(
          `Dev state already initialized (${existingSensors.length} sensors present). Skipping boot seeding.`,
        );
        return;
      }
      await this.seed({ reset: false });
    } catch (err) {
      this.logger.error(
        `Failed to seed dev state on boot: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }

  async seed(options: { reset?: boolean; configPath?: string } = {}): Promise<SeedResult> {
    const reset = options.reset === true;
    const path = resolve(options.configPath || './config/dev-state.yml');

    if (!existsSync(path)) {
      this.logger.warn(`Dev state config not found at ${path}`);
      return { ok: false, sensors: 0, cameras: 0, users: 0, inviteCodes: 0, features: 0, reset };
    }

    let devState: DevStateYaml;
    try {
      const raw = readFileSync(path, 'utf8');
      devState = parse(raw) as DevStateYaml;
    } catch (err) {
      this.logger.error(`Invalid dev-state.yml syntax: ${(err as Error).message}`);
      throw err;
    }

    const now = new Date();

    this.db.transaction((tx) => {
      if (reset) {
        tx.delete(userSensorMutes).run();
        tx.delete(motionEvents).run();
        tx.delete(sensorLogs).run();
        tx.delete(events).run();
        tx.delete(sensors).run();
        tx.delete(cameras).run();
        tx.delete(inviteCodes).run();
        tx.delete(users).run();
      }

      if (Array.isArray(devState.sensors)) {
        for (const s of devState.sensors) {
          tx.insert(sensors)
            .values({
              id: s.id,
              name: s.name,
              type: s.type,
              config: s.config ?? null,
              debounceMs: s.debounceMs ?? 1000,
              severity: s.severity ?? 'info',
              enabled: s.enabled !== false,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: sensors.id,
              set: {
                name: s.name,
                type: s.type,
                config: s.config ?? null,
                debounceMs: s.debounceMs ?? 1000,
                severity: s.severity ?? 'info',
                enabled: s.enabled !== false,
                updatedAt: now,
              },
            })
            .run();
        }
      }

      if (Array.isArray(devState.cameras)) {
        for (const c of devState.cameras) {
          tx.insert(cameras)
            .values({
              id: c.id,
              name: c.name,
              type: c.type,
              config: c.config ?? null,
              enabled: c.enabled !== false,
            })
            .onConflictDoUpdate({
              target: cameras.id,
              set: {
                name: c.name,
                type: c.type,
                config: c.config ?? null,
                enabled: c.enabled !== false,
              },
            })
            .run();
        }
      }

      if (Array.isArray(devState.users)) {
        for (const u of devState.users) {
          tx.insert(users)
            .values({
              telegramId: u.telegramId,
              name: u.name,
              role: u.role,
              muted: u.muted === true,
              createdAt: now,
            })
            .onConflictDoUpdate({
              target: users.telegramId,
              set: {
                name: u.name,
                role: u.role,
                muted: u.muted === true,
              },
            })
            .run();
        }
      }

      if (Array.isArray(devState.invite_codes)) {
        for (const i of devState.invite_codes) {
          tx.insert(inviteCodes)
            .values({
              code: i.code,
              role: i.role,
              createdBy: i.createdBy ?? null,
              createdAt: now,
            })
            .onConflictDoUpdate({
              target: inviteCodes.code,
              set: {
                role: i.role,
                createdBy: i.createdBy ?? null,
              },
            })
            .run();
        }
      }

      if (Array.isArray(devState.features)) {
        for (const f of devState.features) {
          tx.insert(features)
            .values({
              name: f.name,
              enabled: f.enabled !== false,
              installed: f.installed !== false,
              config: f.config ?? null,
            })
            .onConflictDoUpdate({
              target: features.name,
              set: {
                enabled: f.enabled !== false,
                installed: f.installed !== false,
                config: f.config ?? null,
              },
            })
            .run();
        }
      }
    });

    const sCount = devState.sensors?.length ?? 0;
    const cCount = devState.cameras?.length ?? 0;
    const uCount = devState.users?.length ?? 0;
    const iCount = devState.invite_codes?.length ?? 0;
    const fCount = devState.features?.length ?? 0;

    this.logger.log(
      `Dev state seeded successfully (${sCount} sensors, ${cCount} cameras, ${uCount} users, ${iCount} invites, ${fCount} features).`,
    );

    // Reload active driver pipeline to sync in-memory mocks with DB changes
    await this.sensorRegistry.reload();

    return {
      ok: true,
      sensors: sCount,
      cameras: cCount,
      users: uCount,
      inviteCodes: iCount,
      features: fCount,
      reset,
    };
  }
}
