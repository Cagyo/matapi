import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as envWriter from '../../scripts/setup-wizard/env-writer';

const { writeConfig } = envWriter;

const installDirs: string[] = [];

function createInstallDir(): string {
  const installDir = mkdtempSync(join(tmpdir(), 'home-worker-setup-'));
  installDirs.push(installDir);
  writeFileSync(
    join(installDir, '.env.example'),
    'TELEGRAM_BOT_TOKEN=old-token\nCLAIM_ADMIN_TOKEN=old-claim-token\nLIVE_STREAM_ENABLED=false\n',
  );
  return installDir;
}

afterEach(() => {
  for (const installDir of installDirs.splice(0)) {
    rmSync(installDir, { recursive: true, force: true });
  }
});

describe('writeConfig', () => {
  it('stores the supplied claim token exactly once and returns it', () => {
    const installDir = createInstallDir();

    const result = writeConfig(
      installDir,
      '  123456:telegram-token  ',
      [],
      'fixed-claim-token',
    );
    const envContent = readFileSync(join(installDir, '.env'), 'utf8');
    const envLines = envContent.trimEnd().split('\n');

    expect(envLines.filter((line) => line.startsWith('TELEGRAM_BOT_TOKEN='))).toEqual([
      'TELEGRAM_BOT_TOKEN=123456:telegram-token',
    ]);
    expect(envLines.filter((line) => line.startsWith('CLAIM_ADMIN_TOKEN='))).toEqual([
      'CLAIM_ADMIN_TOKEN=fixed-claim-token',
    ]);
    expect(result).toEqual({ claimAdminToken: 'fixed-claim-token' });
  });

  it('generates a 32-character base64url claim token when none is supplied', () => {
    const installDir = createInstallDir();

    const result = writeConfig(installDir, '123456:telegram-token', []);
    const envContent = readFileSync(join(installDir, '.env'), 'utf8');

    expect(result.claimAdminToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(envContent).toContain(`CLAIM_ADMIN_TOKEN=${result.claimAdminToken}`);
  });

  it('enables the runtime gate and feature state for an explicit live-stream selection', () => {
    const installDir = createInstallDir();

    writeConfig(installDir, '123456:telegram-token', ['motion', 'rtsp']);

    expect(readFileSync(join(installDir, '.env'), 'utf8')).toContain(
      'LIVE_STREAM_ENABLED=true',
    );
    expect(JSON.parse(readFileSync(join(installDir, 'features.json'), 'utf8'))).toMatchObject({
      enabled: ['motion', 'rtsp'],
      liveStream: true,
    });
  });

  it('disables the runtime gate and feature state when live streaming is deselected', () => {
    const installDir = createInstallDir();

    writeConfig(installDir, '123456:telegram-token', ['motion']);

    expect(readFileSync(join(installDir, '.env'), 'utf8')).toContain(
      'LIVE_STREAM_ENABLED=false',
    );
    expect(JSON.parse(readFileSync(join(installDir, 'features.json'), 'utf8'))).toMatchObject({
      enabled: ['motion'],
      liveStream: false,
    });
  });
});
