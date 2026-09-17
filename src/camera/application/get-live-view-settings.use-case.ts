import { Inject, Injectable } from "@nestjs/common";

import type { LiveViewSettingsDocument } from "../domain/live-view-settings";
import {
  LIVE_VIEW_MIGRATION_ATTENTION,
  type LiveViewMigrationAttention,
  type LiveViewMigrationAttentionPort,
} from "../domain/ports/live-view-migration-attention.port";
import {
  LIVE_VIEW_SETTINGS_STORE,
  type LiveViewSettingsStorePort,
} from "../domain/ports/live-view-settings-store.port";

export interface LiveViewSettingsStatus {
  readonly configured: LiveViewSettingsDocument | null;
  readonly bootLoadedGeneration: number | null;
  readonly restartRequired: boolean;
  readonly migrationAttention: LiveViewMigrationAttention | null;
  readonly repairRequired: boolean;
}

@Injectable()
export class GetLiveViewSettingsUseCase {
  constructor(
    @Inject(LIVE_VIEW_SETTINGS_STORE)
    private readonly settings: LiveViewSettingsStorePort,
    @Inject(LIVE_VIEW_MIGRATION_ATTENTION)
    private readonly attention: LiveViewMigrationAttentionPort,
  ) {}

  async execute(): Promise<LiveViewSettingsStatus> {
    let configured: LiveViewSettingsDocument;
    try {
      configured = await this.settings.readCommitted();
    } catch {
      return repairStatus();
    }

    const bootLoadedGeneration = this.settings.bootLoadedGeneration();
    let migrationAttention: LiveViewMigrationAttention | null;
    try {
      migrationAttention = await this.attention.read();
    } catch {
      return {
        configured,
        bootLoadedGeneration,
        restartRequired: configured.generation !== bootLoadedGeneration,
        migrationAttention: null,
        repairRequired: true,
      };
    }

    return {
      configured,
      bootLoadedGeneration,
      restartRequired: configured.generation !== bootLoadedGeneration,
      migrationAttention,
      repairRequired: false,
    };
  }
}

function repairStatus(): LiveViewSettingsStatus {
  return {
    configured: null,
    bootLoadedGeneration: null,
    restartRequired: false,
    migrationAttention: null,
    repairRequired: true,
  };
}
