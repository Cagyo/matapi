import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as setupServer from '../../scripts/setup-wizard/server';
import * as envWriter from '../../scripts/setup-wizard/env-writer';

const { createSetupServer } = setupServer;
const TEST_SECRET = 'test-pairing-secret';

interface ServerDependencies {
  installDir: string;
  catalog: { name: string; description: string }[];
  pairingSecret: string;
  validateToken: (token: string) => Promise<Record<string, unknown>> | Record<string, unknown>;
  writeConfig: (installDir: string, token: string, features: string[]) => { claimAdminToken: string };
  onComplete: () => void;
}

const installDirs: string[] = [];

function createInstallDir(): string {
  const installDir = mkdtempSync(join(tmpdir(), 'home-worker-setup-server-'));
  installDirs.push(installDir);
  return installDir;
}

async function startTestServer(overrides: Partial<ServerDependencies> = {}) {
  const installDir = overrides.installDir ?? createInstallDir();
  const writeConfig = overrides.writeConfig ?? vi.fn(() => ({ claimAdminToken: 'claim-token' }));
  const server = createSetupServer({
    installDir,
    catalog: [],
    pairingSecret: TEST_SECRET,
    validateToken: overrides.validateToken ?? vi.fn(),
    writeConfig,
    onComplete: overrides.onComplete ?? vi.fn(),
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${address.port}`, writeConfig, installDir };
}

async function post(url: string, route: string, body: Record<string, string>) {
  return fetch(`${url}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

afterEach(() => {
  for (const installDir of installDirs.splice(0)) {
    rmSync(installDir, { recursive: true, force: true });
  }
});

describe('createSetupServer', () => {
  it('rejects an unpaired token validation without calling validation', async () => {
    const validateToken = vi.fn();
    const { server, url } = await startTestServer({ validateToken });

    const response = await post(url, '/api/validate-token', { token: 'bot-token' });

    expect(response.status).toBe(403);
    expect(validateToken).not.toHaveBeenCalled();
    await close(server);
  });

  it('rejects an unpaired feature-selection request before rendering', async () => {
    const { server, url } = await startTestServer();

    const response = await post(url, '/step-2', { token: 'bot-token' });

    expect(response.status).toBe(403);
    expect(await response.text()).toBe('Forbidden');
    await close(server);
  });

  it('rejects an unpaired finalization without calling validation or writing config', async () => {
    const validateToken = vi.fn();
    const writeConfig = vi.fn();
    const { server, url } = await startTestServer({ validateToken, writeConfig });

    const response = await post(url, '/finish', { token: 'bot-token' });

    expect(response.status).toBe(403);
    expect(validateToken).not.toHaveBeenCalled();
    expect(writeConfig).not.toHaveBeenCalled();
    await close(server);
  });

  it('does not write config when a paired finalization token is invalid', async () => {
    const { server, url, writeConfig } = await startTestServer({
      validateToken: vi.fn().mockResolvedValue({ ok: false, error: 'Invalid Telegram bot token.' }),
    });

    const response = await post(url, '/finish', { pairingSecret: TEST_SECRET, token: 'bad' });

    expect(response.status).toBe(400);
    expect(writeConfig).not.toHaveBeenCalled();
    expect(await response.text()).toContain('Invalid Telegram bot token.');
    await close(server);
  });

  it('writes only a paired validator-cleaned token before completing', async () => {
    const validateToken = vi.fn().mockResolvedValue({
      ok: true,
      cleanedToken: 'cleaned-bot-token',
      username: 'home_bot',
    });
    const writeConfig = vi.fn(() => ({ claimAdminToken: 'claim-token' }));
    const onComplete = vi.fn();
    const { server, url } = await startTestServer({ validateToken, writeConfig, onComplete });

    const response = await post(url, '/finish', {
      pairingSecret: TEST_SECRET,
      token: ' untrusted-bot-token ',
      botUsername: 'home_bot',
      features: 'motion',
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('/claim_admin claim-token');
    expect(writeConfig).toHaveBeenCalledWith(expect.any(String), 'cleaned-bot-token', ['motion']);
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    await close(server);
  });

  it('writes selected rtsp state through HTTP to both env and features files', async () => {
    const installDir = createInstallDir();
    writeFileSync(
      join(installDir, '.env.example'),
      'TELEGRAM_BOT_TOKEN=\nCLAIM_ADMIN_TOKEN=\nLIVE_STREAM_ENABLED=false\n',
    );
    const { server, url } = await startTestServer({
      installDir,
      validateToken: vi.fn().mockResolvedValue({
        ok: true,
        cleanedToken: '123456:telegram-token',
        username: 'home_bot',
      }),
      writeConfig: envWriter.writeConfig,
    });

    const response = await post(url, '/finish', {
      pairingSecret: TEST_SECRET,
      token: '123456:telegram-token',
      features: 'rtsp',
    });

    expect(response.status).toBe(200);
    expect(readFileSync(join(installDir, '.env'), 'utf8')).toContain(
      'LIVE_STREAM_ENABLED=true',
    );
    expect(JSON.parse(readFileSync(join(installDir, 'features.json'), 'utf8'))).toMatchObject({
      enabled: ['rtsp'],
      liveStream: true,
    });
    await close(server);
  });

  it('writes deselected rtsp state through HTTP to both env and features files', async () => {
    const installDir = createInstallDir();
    writeFileSync(
      join(installDir, '.env.example'),
      'TELEGRAM_BOT_TOKEN=\nCLAIM_ADMIN_TOKEN=\nLIVE_STREAM_ENABLED=true\n',
    );
    const { server, url } = await startTestServer({
      installDir,
      validateToken: vi.fn().mockResolvedValue({
        ok: true,
        cleanedToken: '123456:telegram-token',
        username: 'home_bot',
      }),
      writeConfig: envWriter.writeConfig,
    });

    const response = await post(url, '/finish', {
      pairingSecret: TEST_SECRET,
      token: '123456:telegram-token',
      features: 'motion',
    });

    expect(response.status).toBe(200);
    expect(readFileSync(join(installDir, '.env'), 'utf8')).toContain(
      'LIVE_STREAM_ENABLED=false',
    );
    expect(JSON.parse(readFileSync(join(installDir, 'features.json'), 'utf8'))).toMatchObject({
      enabled: ['motion'],
      liveStream: false,
    });
    await close(server);
  });
});
