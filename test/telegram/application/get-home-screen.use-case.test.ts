import { describe, expect, it, vi } from 'vitest';
import type { SensorDashboardPage } from '../../../src/sensors/domain/sensor-dashboard-page';
import type { HomeSummary } from '../../../src/telegram/application/get-home-summary.use-case';
import { GetHomeScreenUseCase } from '../../../src/telegram/application/get-home-screen.use-case';

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
    const useCase = new GetHomeScreenUseCase(getSummary, sensors);

    await expect(useCase.execute({
      userId: 7,
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
    const useCase = new GetHomeScreenUseCase(getSummary, sensors);

    await expect(useCase.execute({
      userId: 7,
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
    const useCase = new GetHomeScreenUseCase(getSummary, sensors);

    await expect(useCase.execute({
      userId: 7,
      role: 'user',
      view: { kind: 'sensors', page: 0, checking: true },
    })).resolves.toMatchObject({ kind: 'sensors', checking: true, isAdmin: false });
  });
});
