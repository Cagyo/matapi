import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FeatureSeederService } from '../../../src/features/application/feature-seeder.service';
import { FEATURE_CATALOG } from '../../../src/features/domain/feature-catalog';

describe('FeatureSeederService', () => {
  let seeder: FeatureSeederService;
  let config: { loadEnabled: ReturnType<typeof vi.fn> };
  let query: { listAll: ReturnType<typeof vi.fn> };
  let repository: { insertMissing: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    config = { loadEnabled: vi.fn() };
    query = { listAll: vi.fn() };
    repository = { insertMissing: vi.fn().mockResolvedValue(undefined) };
    seeder = new FeatureSeederService(config, query, repository);
  });

  it('does not touch a complete catalogue', async () => {
    query.listAll.mockResolvedValue(FEATURE_CATALOG.map(({ name }) => ({ name })));
    await seeder.onModuleInit();
    expect(repository.insertMissing).not.toHaveBeenCalled();
  });

  it.each([null, []])('never seeds success from a missing or malformed config result', async (enabled) => {
    query.listAll.mockResolvedValue([]);
    config.loadEnabled.mockResolvedValue(enabled);
    await seeder.onModuleInit();
    expect(repository.insertMissing).toHaveBeenCalledWith(FEATURE_CATALOG.map(({ name }) => ({
      name, installed: false, enabled: false,
    })));
  });

  it('marks only the final verified enabled list installed and enabled on an empty database', async () => {
    query.listAll.mockResolvedValue([]);
    config.loadEnabled.mockResolvedValue(['digital', 'motion']);
    await seeder.onModuleInit();
    expect(repository.insertMissing).toHaveBeenCalledWith(FEATURE_CATALOG.map(({ name }) => ({
      name, installed: name === 'digital' || name === 'motion', enabled: name === 'digital' || name === 'motion',
    })));
  });

  it('adds only missing catalogue rows without consulting first-install config on upgrades', async () => {
    query.listAll.mockResolvedValue([{ name: 'motion' }, { name: 'uart' }]);
    await seeder.onModuleInit();
    expect(config.loadEnabled).not.toHaveBeenCalled();
    expect(repository.insertMissing).toHaveBeenCalledWith(expect.arrayContaining([
      { name: 'digital', installed: false, enabled: false },
      { name: 'zigbee', installed: false, enabled: false },
      { name: 'rtsp', installed: false, enabled: false },
    ]));
  });
});
