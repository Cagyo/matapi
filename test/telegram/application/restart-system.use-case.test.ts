import { describe, expect, it, vi } from 'vitest';
import {
  RestartSystemUseCase,
  RESTART_REASON_KEY,
  RESTART_REASON_USER_COMMAND,
} from '../../../src/telegram/application/restart-system.use-case';
import { SystemMetaRepositoryPort } from '../../../src/system/domain/ports/system-meta-repository.port';
import { ProcessRestarterPort } from '../../../src/system/domain/ports/process-restarter.port';

function makeMeta(): SystemMetaRepositoryPort {
  const store = new Map<string, string>();
  return {
    get: async (key) => store.get(key) ?? null,
    set: async (key, value) => {
      store.set(key, value);
    },
    delete: async (key) => {
      store.delete(key);
    },
  };
}

describe('RestartSystemUseCase', () => {
  it('flags the restart reason before invoking the supervisor', async () => {
    const meta = makeMeta();
    const calls: string[] = [];
    const restart = vi.fn(async () => {
      calls.push('restart');
    });
    const wrappedSet = meta.set.bind(meta);
    meta.set = async (key: string, value: string) => {
      calls.push(`set:${key}=${value}`);
      await wrappedSet(key, value);
    };
    const restarter: ProcessRestarterPort = { restart };
    const useCase = new RestartSystemUseCase(meta, restarter);

    await useCase.execute();

    expect(calls).toEqual([
      `set:${RESTART_REASON_KEY}=${RESTART_REASON_USER_COMMAND}`,
      'restart',
    ]);
    expect(await meta.get(RESTART_REASON_KEY)).toBe(RESTART_REASON_USER_COMMAND);
  });
});
