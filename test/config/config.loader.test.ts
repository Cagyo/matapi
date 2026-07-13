import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmpRoot = resolve('test/.tmp/config-loader');

async function loadFreshModule() {
  vi.resetModules();
  return import('../../src/config/config.loader');
}

function writeConfig(path: string, aggregateLimit: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    [
      'sensor_defaults:',
      '  digital:',
      '    debounce_ms: 1000',
      '    severity: info',
      'notifications:',
      '  quiet_hours_default: null',
      `  max_queue_before_force_aggregate: ${aggregateLimit}`,
      '',
    ].join('\n'),
    'utf8',
  );
}

describe('loadDefaults', () => {
  beforeEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    mkdirSync(tmpRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('loads and parses a YAML defaults file', async () => {
    const path = resolve(tmpRoot, 'defaults.yml');
    writeConfig(path, 42);
    const { loadDefaults } = await loadFreshModule();

    expect(loadDefaults(path)).toMatchObject({
      sensor_defaults: {
        digital: { debounce_ms: 1000, severity: 'info' },
      },
      notifications: {
        quiet_hours_default: null,
        max_queue_before_force_aggregate: 42,
      },
    });
  });

  it('returns the cached config after the first successful load', async () => {
    const firstPath = resolve(tmpRoot, 'first.yml');
    const secondPath = resolve(tmpRoot, 'second.yml');
    writeConfig(firstPath, 10);
    writeConfig(secondPath, 99);
    const { loadDefaults } = await loadFreshModule();

    const first = loadDefaults(firstPath);
    const second = loadDefaults(secondPath);

    expect(second).toBe(first);
    expect(second.notifications.max_queue_before_force_aggregate).toBe(10);
  });

  it('throws when the file cannot be read', async () => {
    const { loadDefaults } = await loadFreshModule();

    expect(() => loadDefaults(resolve(tmpRoot, 'missing.yml'))).toThrow(/ENOENT/);
  });
});