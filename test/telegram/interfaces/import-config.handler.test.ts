import { describe, expect, it, vi } from 'vitest';
import { en } from '../../../src/locales/en';
import type { ImportCameraLiveSourcesUseCase } from '../../../src/telegram/application/import-camera-live-sources.use-case';
import type { ImportSensorsUseCase } from '../../../src/sensors/application/import-sensors.use-case';
import type { ConfigCodecPort } from '../../../src/telegram/domain/ports/config-codec.port';
import type { UserRepositoryPort } from '../../../src/telegram/domain/ports/user-repository.port';
import { ImportConfigHandler } from '../../../src/telegram/interfaces/import-config.handler';
import type { RoleMiddleware } from '../../../src/telegram/interfaces/role.middleware';
import type { TelegramContext } from '../../../src/telegram/interfaces/telegram-context';

const sensorPlan = {
  batch: { inserts: [], updates: [], archives: [] },
  summary: { added: ['sensor'], updated: [], archived: [] },
};
const cameraPlan = { sources: [], configured: ['front_door'] };

function fixture(roles: ('admin' | 'user')[] = ['admin', 'admin']) {
  const order: string[] = [];
  const importSensors = {
    commit: vi.fn(async () => {
      order.push('sensors');
      return sensorPlan.summary;
    }),
  } as unknown as ImportSensorsUseCase;
  const importCameraSources = {
    commit: vi.fn(async () => {
      order.push('cameras');
      return cameraPlan.configured;
    }),
  } as unknown as ImportCameraLiveSourcesUseCase;
  const users = {
    findByTelegramId: vi.fn(async () => {
      order.push('role');
      const role = roles.shift() ?? 'user';
      return { role };
    }),
  } as unknown as UserRepositoryPort;
  const handler = new ImportConfigHandler(
    importSensors,
    importCameraSources,
    {} as ConfigCodecPort,
    {} as RoleMiddleware,
    users,
  );
  const states = (handler as unknown as {
    states: Map<number, unknown>;
  }).states;
  states.set(42, { kind: 'awaitingConfirm', sensorPlan, cameraPlan });
  const ctx = {
    from: { id: 42 },
    callbackQuery: { data: 'imp:apply' },
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    localeState: {
      catalog: en,
      locale: 'en',
      user: { role: 'admin' },
    },
  } as unknown as TelegramContext;
  return { handler, importSensors, importCameraSources, ctx, order };
}

async function apply(handler: ImportConfigHandler, ctx: TelegramContext) {
  await (handler as unknown as {
    onCallback(context: TelegramContext): Promise<void>;
  }).onCallback(ctx);
}

describe('ImportConfigHandler live-source confirmation', () => {
  it('uses one confirmation, rechecks admin before each camera-first write phase', async () => {
    const { handler, ctx, order } = fixture();
    await apply(handler, ctx);
    expect(order).toEqual(['role', 'cameras', 'role', 'sensors']);
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('1 live sources configured without credentials'),
    );
  });

  it('truthfully reports camera-applied sensor-failed partial state', async () => {
    const { handler, ctx, importSensors } = fixture();
    vi.mocked(importSensors.commit).mockRejectedValueOnce(new Error('sensor failure'));
    await apply(handler, ctx);
    expect(ctx.reply).toHaveBeenCalledWith(en.importConfig.partialFailed);
  });

  it('reports an uncertain persisted state when a sensor-only commit rejects', async () => {
    const { handler, ctx, importSensors, importCameraSources } = fixture();
    const states = (handler as unknown as { states: Map<number, unknown> }).states;
    states.set(42, {
      kind: 'awaitingConfirm',
      sensorPlan,
      cameraPlan: { sources: [], configured: [] },
    });
    vi.mocked(importSensors.commit).mockRejectedValueOnce(new Error('reload failed'));
    await apply(handler, ctx);
    expect(importCameraSources.commit).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(
      en.importConfig.sensorOutcomeUncertain,
    );
  });

  it('stops after the second role check and reports the applied camera phase', async () => {
    const { handler, ctx, importSensors } = fixture(['admin', 'user']);
    await apply(handler, ctx);
    expect(importSensors.commit).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(en.importConfig.partialRoleChanged);
  });

  it('does not report a mutation failure when only the success reply fails', async () => {
    const { handler, ctx, importSensors, importCameraSources } = fixture();
    vi.mocked(ctx.reply).mockRejectedValueOnce(new Error('telegram offline'));
    await expect(apply(handler, ctx)).resolves.toBeUndefined();
    expect(importCameraSources.commit).toHaveBeenCalledOnce();
    expect(importSensors.commit).toHaveBeenCalledOnce();
    expect(ctx.reply).toHaveBeenCalledOnce();
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('Config imported'),
    );
  });
});
