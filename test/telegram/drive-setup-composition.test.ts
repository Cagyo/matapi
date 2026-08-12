import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { TelegramModule } from '../../src/telegram/telegram.module';
import { DemoteHandler } from '../../src/telegram/interfaces/demote.handler';
import { DriveSetupStateRegistry } from '../../src/telegram/interfaces/drive-setup-state.registry';
import { GdriveHandler } from '../../src/telegram/interfaces/gdrive.handler';
import { WorkflowDraftRegistry } from '../../src/telegram/interfaces/workflow-draft.registry';
import { TelegramDriveAuthorizationOutcomeAdapter } from '../../src/telegram/infrastructure/telegram-drive-authorization-outcome.adapter';

describe('Telegram Drive setup composition', () => {
  it('registers one shared Drive setup registry for every consumer and its draft cancellation', async () => {
    const providers = Reflect.getMetadata('providers', TelegramModule) as unknown[];
    expect(providers.filter((provider) => provider === DriveSetupStateRegistry)).toHaveLength(1);

    const app = await NestFactory.createApplicationContext(TelegramModule, { logger: false });
    try {
      const registry = app.get(DriveSetupStateRegistry);
      const drafts = app.get(WorkflowDraftRegistry);

      expect(app.get(GdriveHandler)).toHaveProperty('setupStates', registry);
      expect(app.get(DemoteHandler)).toHaveProperty('setupStates', registry);
      expect(app.get(TelegramDriveAuthorizationOutcomeAdapter)).toHaveProperty('setupStates', registry);
      expect(drafts.cancellers.get('drive-setup')).toBe(registry);
    } finally {
      await app.close();
    }
  });
});
