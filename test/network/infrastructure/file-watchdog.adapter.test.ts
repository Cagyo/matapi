import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { FileWatchdogAdapter } from '../../../src/network/infrastructure/file-watchdog.adapter';

const tmpRoot = resolve('test/.tmp/file-watchdog');

describe('FileWatchdogAdapter', () => {
  let dir: string;
  let device: string;

  beforeEach(async () => {
    await mkdir(tmpRoot, { recursive: true });
    dir = await mkdtemp(join(tmpRoot, 'wd-'));
    device = join(dir, 'watchdog');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a pet byte and disarms with the magic close character', async () => {
    const adapter = new FileWatchdogAdapter(device);

    await adapter.open();
    await adapter.pet();
    await adapter.pet();
    await adapter.close();

    // Two pets ('1') then the magic disarm ('V').
    expect(await readFile(device, 'utf8')).toBe('11V');
  });

  it('pet is a no-op before open', async () => {
    const adapter = new FileWatchdogAdapter(device);

    await expect(adapter.pet()).resolves.toBeUndefined();
  });

  it('close is a no-op before open', async () => {
    const adapter = new FileWatchdogAdapter(device);

    await expect(adapter.close()).resolves.toBeUndefined();
  });
});
