import { describe, expect, it, vi } from 'vitest';
import type { SensorDashboardPage } from '../../../src/sensors/domain/sensor-dashboard-page';
import type { HomeSummary } from '../../../src/telegram/application/get-home-summary.use-case';
import { GetHomeScreenUseCase } from '../../../src/telegram/application/get-home-screen.use-case';
import { homeViewForScreen } from '../../../src/telegram/application/home-screen';

const summary: HomeSummary = {
  verdict: 'normal',
  sensors: [],
  attention: [],
  attentionTotal: 0,
  knownCount: 0,
  unknownCount: 0,
  health: null,
  healthFresh: false,
  notificationState: { kind: 'normal' },
};

const page: SensorDashboardPage = {
  sensors: [],
  requestedPage: 12,
  page: 2,
  pageCount: 3,
  total: 17,
  clamped: true,
};

describe('GetHomeScreenUseCase', () => {
  it('reads the shared summary once for a Home screen without loading a sensor page', async () => {
    const getSummary = { execute: vi.fn().mockResolvedValue(summary) };
    const sensors = { listDashboardPage: vi.fn() };
    const useCase = new GetHomeScreenUseCase(getSummary, sensors, { execute: vi.fn() }, { listEnabled: vi.fn() });

    await expect(useCase.execute({
      userId: 7,
      chatId: 70,
      role: 'user',
      view: { kind: 'home', checking: true },
    })).resolves.toEqual({ kind: 'home', summary, checking: true });
    expect(getSummary.execute).toHaveBeenCalledTimes(1);
    expect(getSummary.execute).toHaveBeenCalledWith(7);
    expect(sensors.listDashboardPage).not.toHaveBeenCalled();
  });

  it('adds the clamped eight-row Sensors page while retaining the global summary and role capability', async () => {
    const getSummary = { execute: vi.fn().mockResolvedValue(summary) };
    const sensors = { listDashboardPage: vi.fn().mockResolvedValue(page) };
    const useCase = new GetHomeScreenUseCase(getSummary, sensors, { execute: vi.fn() }, { listEnabled: vi.fn() });

    await expect(useCase.execute({
      userId: 7,
      chatId: 70,
      role: 'admin',
      view: { kind: 'sensors', page: 12, checking: false },
    })).resolves.toEqual({
      kind: 'sensors',
      summary,
      page,
      checking: false,
      isAdmin: true,
    });
    expect(getSummary.execute).toHaveBeenCalledTimes(1);
    expect(sensors.listDashboardPage).toHaveBeenCalledWith({ page: 12, pageSize: 8 });
  });

  it('exposes member empty-state capability without rendering transport strings', async () => {
    const getSummary = { execute: vi.fn().mockResolvedValue(summary) };
    const sensors = { listDashboardPage: vi.fn().mockResolvedValue(page) };
    const useCase = new GetHomeScreenUseCase(getSummary, sensors, { execute: vi.fn() }, { listEnabled: vi.fn() });

    await expect(useCase.execute({
      userId: 7,
      chatId: 70,
      role: 'user',
      view: { kind: 'sensors', page: 0, checking: true },
    })).resolves.toMatchObject({ kind: 'sensors', checking: true, isAdmin: false });
  });

  it('clamps notification-target pages, persists only the rendered typed target refs, and avoids summary reads', async () => {
    const getSummary = { execute: vi.fn() };
    const sensors = { listDashboardPage: vi.fn() };
    const rows = Array.from({ length: 9 }, (_, index) => ({
      ref: { kind: index % 2 === 0 ? 'sensor' as const : 'camera' as const, id: `target-${index}` },
      name: `Target ${index}`,
      kind: index % 2 === 0 ? 'sensor' as const : 'camera' as const,
      muted: false,
    }));
    const targets = { listEnabled: vi.fn().mockResolvedValue(rows) };
    const useCase = new GetHomeScreenUseCase(getSummary, sensors, { execute: vi.fn() }, targets);

    const screen = await useCase.execute({ userId: 7, chatId: 70, role: 'user', view: { kind: 'notification-targets', page: 12, targets: [] } });
    expect(screen).toMatchObject({ kind: 'notification-targets', page: { requestedPage: 12, page: 1, pageCount: 2, total: 9, clamped: true, targets: [rows[8]] } });
    expect(homeViewForScreen(screen)).toEqual({ kind: 'notification-targets', page: 1, targets: [rows[8].ref] });
    expect(getSummary.execute).not.toHaveBeenCalled();
  });

  it('uses the strict threshold use case for the Home admin system screen', async () => {
    const threshold = { current: vi.fn().mockResolvedValue(85) };
    const useCase = new GetHomeScreenUseCase(
      { execute: vi.fn() }, { listDashboardPage: vi.fn() }, { execute: vi.fn() }, { listEnabled: vi.fn() },
      threshold as never,
    );

    await expect(useCase.execute({ userId: 7, chatId: 70, role: 'admin', view: { kind: 'admin-system' } }))
      .resolves.toEqual({ kind: 'admin-system', autoCleanThreshold: 85 });
    expect(threshold.current).toHaveBeenCalledOnce();
  });
});
