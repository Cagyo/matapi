import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as setupServer from '../../scripts/setup-wizard/server';

const { createSetupServer } = setupServer;
const TEST_SECRET = 'test-pairing-secret';

type ServerDependencies = {
  installDir: string;
  catalog: Array<{ name: string; description: string }>;
  pairingSecret: string;
  validateToken: (token: string) => Promise<Record<string, unknown>> | Record<string, unknown>;
  writeConfig: (installDir: string, token: string, features: string[]) => { claimAdminToken: string };
  onComplete: () => void;
};

const installDirs: string[] = [];

function createInstallDir(): string {
  const installDir = mkdtempSync(join(tmpdir(), 'home-worker-setup-server-'));
  installDirs.push(installDir);
  return installDir;
}

async function startTestServer(overrides: Partial<ServerDependencies> = {}) {
  const writeConfig = overrides.writeConfig ?? vi.fn(() => ({ claimAdminToken: 'claim-token' }));
  const server = createSetupServer({
    installDir: createInstallDir(),
    catalog: [],
    pairingSecret: TEST_SECRET,
    validateToken: overrides.validateToken ?? vi.fn(),
    writeConfig,
    onComplete: overrides.onComplete ?? vi.fn(),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${address.port}`, writeConfig };
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
});
