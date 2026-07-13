import { mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LiveSource } from '../../../src/camera/domain/live-source.entity';
import { SystemdFfmpegStreamAdapter } from '../../../src/camera/infrastructure/systemd-ffmpeg-stream.adapter';

const SESSION = '01901f4c-b7f4-4c6a-a787-3f8a442c85d2';

function source() {
  const entity = LiveSource.create({
    cameraId: 'front',
    url: 'rtsp://user:p%40ss@192.168.1.20:554/live?x=1',
    transport: 'tcp',
    profile: 'eco',
    ready: true,
  });
  return { source: entity, credential: entity.credentialPayload() };
}

function startInput(sessionId = SESSION) {
  return {
    sessionId,
    source: source(),
    connectionAddress: '192.168.1.20',
    tlsServerName: null,
    expiresAtUnixMs: Date.now() + 30_000,
  };
}

describe('SystemdFfmpegStreamAdapter', () => {
  it('atomically writes a private fixed-schema config and asks the helper to start the exact UUID unit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stream-sandbox-'));
    const execFile = vi.fn(async (_file: string, args: readonly string[]) => ({ stdout: args.includes('show') ? '4321\n987654\n' : 'active\n', stderr: '' }));
    await mkdir(join(root, 'config')); await mkdir(join(root, 'output'));
    const adapter = new SystemdFfmpegStreamAdapter({
      configDirectory: join(root, 'config'),
      outputDirectory: join(root, 'output'),
      startupTimeoutMs: 1_000,
    }, { execFile, inspectSocket: vi.fn(async () => undefined), inspectRuntimeDirectory: vi.fn(async () => undefined), inspectCaFile: vi.fn(async () => undefined) });

    const result = await adapter.start(startInput());

    expect(execFile).toHaveBeenNthCalledWith(1, 'systemctl', ['--no-ask-password', 'start', `homeworker-ffmpeg-stream@${SESSION}.service`], {
      shell: false, timeout: 1_000, maxBuffer: 65_536,
    });
    expect(execFile).toHaveBeenNthCalledWith(2, 'systemctl', ['--no-ask-password', 'is-active', `homeworker-ffmpeg-stream@${SESSION}.service`], {
      shell: false, timeout: 1_000, maxBuffer: 65_536,
    });
    expect(result).toEqual({
      processIdentity: 'pid:4321:start:987654',
      health: { ready: true },
      output: {
        kind: 'unix-socket',
        socketPath: join(root, 'output', `${SESSION}.sock`),
        queueCapacityFrames: 2,
      },
    });
    const configPath = join(root, 'config', `${SESSION}.json`);
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    expect(config).toEqual({
      version: 1,
      sessionId: SESSION,
      inputUrl: 'rtsp://user:p%40ss@192.168.1.20:554/live?x=1',
      tlsServerName: null,
      transport: 'tcp',
      tlsMode: 'none',
      profile: 'eco',
      udpPortFirst: 24_000,
      udpPortLast: 24_001,
      outputSocket: join(root, 'output', `${SESSION}.sock`),
      expiresAtUnixMs: expect.any(Number),
      ownerUid: process.getuid?.() ?? -1,
      caFile: null,
    });
    expect((await stat(configPath)).mode & 0o777).toBe(0o640);
  });

  it('never starts until the Unix output contract is prepared and removes credentials on start failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stream-sandbox-fail-'));
    const execFile = vi.fn(async () => { throw new Error('raw secret rtsp://user:pass@camera'); });
    const inspectSocket = vi.fn(async () => { throw new Error('socket unavailable'); });
    const adapter = new SystemdFfmpegStreamAdapter({
      configDirectory: join(root, 'config'),
      outputDirectory: join(root, 'output'),
      startupTimeoutMs: 1_000,
    }, { execFile, inspectSocket, inspectRuntimeDirectory: vi.fn(async () => undefined) });

    await expect(adapter.start(startInput()))
      .rejects.toThrow('stream runtime unavailable');
    expect(execFile).not.toHaveBeenCalled();
  });

  it('rewrites only the runtime authority to the granted literal and preserves strict TLS identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stream-sandbox-tls-'));
    await mkdir(join(root, 'config')); await mkdir(join(root, 'output'));
    const entity = LiveSource.create({
      cameraId: 'front', url: 'rtsps://user:pass@camera.local:322/live?q=1', tlsMode: 'strict', ready: true,
    });
    const execFile = vi.fn(async (_file: string, args: readonly string[]) => ({ stdout: args.includes('show') ? '4321\n987654\n' : 'active\n', stderr: '' }));
    const adapter = new SystemdFfmpegStreamAdapter({
      configDirectory: join(root, 'config'), outputDirectory: join(root, 'output'), startupTimeoutMs: 1_000,
      caFile: '/etc/ssl/certs/ca-certificates.crt',
    }, { execFile, inspectSocket: vi.fn(async () => undefined), inspectRuntimeDirectory: vi.fn(async () => undefined), inspectCaFile: vi.fn(async () => undefined) });

    await adapter.start({
      sessionId: SESSION, source: { source: entity, credential: entity.credentialPayload() },
      connectionAddress: '192.168.1.20', tlsServerName: 'camera.local', expiresAtUnixMs: Date.now() + 30_000,
    });

    const config = JSON.parse(await readFile(join(root, 'config', `${SESSION}.json`), 'utf8')) as Record<string, unknown>;
    expect(config.inputUrl).toBe('rtsps://user:pass@192.168.1.20:322/live?q=1');
    expect(config.tlsServerName).toBe('camera.local');
    expect(config.caFile).toBe('/etc/ssl/certs/ca-certificates.crt');
  });

  it('stops through the helper with bounded structured fields and cleans the session config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stream-sandbox-stop-'));
    const execFile = vi.fn(async (_file: string, args: readonly string[]) => ({ stdout: args.includes('show') ? '4321\n987654\n' : 'active\n', stderr: '' }));
    await mkdir(join(root, 'config')); await mkdir(join(root, 'output'));
    const adapter = new SystemdFfmpegStreamAdapter({
      configDirectory: join(root, 'config'), outputDirectory: join(root, 'output'), startupTimeoutMs: 1_000,
    }, { execFile, inspectSocket: vi.fn(async () => undefined), inspectRuntimeDirectory: vi.fn(async () => undefined) });
    await adapter.start(startInput());

    await adapter.stop(SESSION);

    expect(execFile).toHaveBeenLastCalledWith('systemctl', ['--no-ask-password', 'stop', `homeworker-ffmpeg-stream@${SESSION}.service`], {
      shell: false, timeout: 1_000, maxBuffer: 65_536,
    });
    await expect(readFile(join(root, 'config', `${SESSION}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed when the secret-bearing session config cannot be removed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stream-sandbox-unlink-'));
    const execFile = vi.fn(async () => ({ stdout: 'active\n', stderr: '' }));
    const unlinkFile = vi.fn(async () => { throw Object.assign(new Error('denied secret path'), { code: 'EACCES' }); });
    await mkdir(join(root, 'config')); await mkdir(join(root, 'output'));
    const adapter = new SystemdFfmpegStreamAdapter({
      configDirectory: join(root, 'config'), outputDirectory: join(root, 'output'), startupTimeoutMs: 1_000,
    }, { execFile, unlinkFile });

    await expect(adapter.stop(SESSION)).rejects.toThrow('stream runtime unavailable');
    expect(unlinkFile).toHaveBeenCalledWith(join(root, 'config', `${SESSION}.json`));
  });

  it('compensates with an exact stop and deletes credentials when readiness fails after start', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stream-sandbox-compensate-'));
    await mkdir(join(root, 'config')); await mkdir(join(root, 'output'));
    const execFile = vi.fn(async (_file: string, args: readonly string[]) => ({
      stdout: args.includes('is-active') ? 'failed\n' : '', stderr: 'rtsp://secret',
    }));
    const adapter = new SystemdFfmpegStreamAdapter({
      configDirectory: join(root, 'config'), outputDirectory: join(root, 'output'), startupTimeoutMs: 1_000,
    }, { execFile, inspectSocket: vi.fn(async () => undefined), inspectRuntimeDirectory: vi.fn(async () => undefined) });

    await expect(adapter.start(startInput()))
      .rejects.toThrow('stream runtime unavailable');

    expect(execFile).toHaveBeenLastCalledWith('systemctl', ['--no-ask-password', 'stop', `homeworker-ffmpeg-stream@${SESSION}.service`], {
      shell: false, timeout: 1_000, maxBuffer: 65_536,
    });
    await expect(readFile(join(root, 'config', `${SESSION}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('compensates when systemctl start has an ambiguous timeout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stream-sandbox-ambiguous-'));
    await mkdir(join(root, 'config')); await mkdir(join(root, 'output'));
    const execFile = vi.fn(async (_file: string, args: readonly string[]) => {
      if (args.includes('start')) throw new Error('timeout after activation');
      return { stdout: '', stderr: '' };
    });
    const adapter = new SystemdFfmpegStreamAdapter({
      configDirectory: join(root, 'config'), outputDirectory: join(root, 'output'), startupTimeoutMs: 1_000,
    }, { execFile, inspectSocket: vi.fn(async () => undefined), inspectRuntimeDirectory: vi.fn(async () => undefined) });

    await expect(adapter.start(startInput()))
      .rejects.toThrow('stream runtime unavailable');

    expect(execFile).toHaveBeenLastCalledWith('systemctl', ['--no-ask-password', 'stop', `homeworker-ffmpeg-stream@${SESSION}.service`], {
      shell: false, timeout: 1_000, maxBuffer: 65_536,
    });
  });

  it('escalates a TERM-ignoring systemctl child to SIGKILL and reaps it', async () => {
      const root = await mkdtemp(join(tmpdir(), 'stream-sandbox-reap-'));
      await mkdir(join(root, 'config')); await mkdir(join(root, 'output'));
      let rejectStart!: (error: Error) => void;
      const stuck = new Promise<never>((_, reject) => { rejectStart = reject; });
      const signals: NodeJS.Signals[] = [];
      const startProcess = vi.fn((_file: string, args: readonly string[]) => {
        if (args.includes('start')) {
          return {
            completion: stuck,
            kill: (signal: NodeJS.Signals) => {
              signals.push(signal);
              if (signal === 'SIGKILL') rejectStart(new Error('killed'));
            },
          };
        }
        return { completion: Promise.resolve({ stdout: '', stderr: '' }), kill: vi.fn() };
      });
      const adapter = new SystemdFfmpegStreamAdapter({
        configDirectory: join(root, 'config'), outputDirectory: join(root, 'output'), startupTimeoutMs: 50,
      }, { startProcess, inspectSocket: vi.fn(async () => undefined), inspectRuntimeDirectory: vi.fn(async () => undefined) });
      await expect(adapter.start(startInput())).rejects.toThrow('stream runtime unavailable');

      expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it.each(['s1', '../escape', `${SESSION};reboot`, ''])('rejects unsafe session id %j before side effects', async (sessionId) => {
    const execFile = vi.fn();
    const inspectSocket = vi.fn();
    const adapter = new SystemdFfmpegStreamAdapter({
      configDirectory: '/run/home-worker/live-stream-config', outputDirectory: '/run/home-worker/live-stream-output', startupTimeoutMs: 1_000,
    }, { execFile, inspectSocket, inspectRuntimeDirectory: vi.fn(async () => undefined) });
    await expect(adapter.start(startInput(sessionId)))
      .rejects.toThrow('stream runtime unavailable');
    expect(execFile).not.toHaveBeenCalled();
    expect(inspectSocket).not.toHaveBeenCalled();
  });
});
