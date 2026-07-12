import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeatureSeederService } from '../../../src/features/application/feature-seeder.service';
import { FEATURE_CATALOG } from '../../../src/features/domain/feature-catalog';
import { existsSync, readFileSync } from 'node:fs';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

describe('FeatureSeederService', () => {
  let seeder: FeatureSeederService;
  let mockDb: any;
  let mockQuery: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = {
      transaction: vi.fn((fn: (tx: typeof mockTx) => void) => {
        fn(mockTx);
      }),
    };
    mockQuery = {
      listAll: vi.fn(),
    };
    seeder = new FeatureSeederService(mockDb, mockQuery);
  });

  const mockTx = {
    delete: vi.fn().mockReturnValue({ run: vi.fn() }),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ run: vi.fn() }) }),
  };

  it('skips seeding if database already has all catalog items (Fix 5a guard)', async () => {
    mockQuery.listAll.mockResolvedValue(FEATURE_CATALOG.map(({ name }) => ({ name })));

    await seeder.onModuleInit();

    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('handles malformed features.json without throwing (Fix 5b)', async () => {
    mockQuery.listAll.mockResolvedValue([]);
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('{ bad json');

    await seeder.onModuleInit();

    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('seeds items inside a transaction when features.json is valid (Fix 5a)', async () => {
    mockQuery.listAll.mockResolvedValue([]);
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ enabled: ['digital', 'motion'] }));

    await seeder.onModuleInit();

    expect(mockDb.transaction).toHaveBeenCalled();
    expect(mockTx.insert).toHaveBeenCalledTimes(FEATURE_CATALOG.length);
  });

  it('adds a newly catalogued feature without resetting existing feature state', async () => {
    mockQuery.listAll.mockResolvedValue([
      { name: 'motion', installed: true, enabled: true },
      { name: 'uart', installed: true, enabled: false },
    ]);
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ enabled: ['motion'] }));

    await seeder.onModuleInit();

    expect(mockTx.delete).not.toHaveBeenCalled();
    const insertValues = mockTx.insert.mock.results[0]?.value.values;
    expect(insertValues).toHaveBeenCalledWith({
      name: 'rtsp',
      installed: false,
      enabled: false,
    });
    expect(insertValues).toHaveBeenCalledTimes(FEATURE_CATALOG.length - 2);
  });
});
