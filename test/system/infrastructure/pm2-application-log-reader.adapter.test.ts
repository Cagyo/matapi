import { describe, expect, it, vi } from 'vitest';
import { ApplicationLogUnavailableError } from '../../../src/system/domain/errors/application-log-unavailable.error';
import { Pm2ApplicationLogReaderAdapter } from '../../../src/system/infrastructure/pm2-application-log-reader.adapter';

const outputPath = '/var/log/home-worker/worker-out.log';
const errorPath = '/var/log/home-worker/worker-error.log';

function pm2List(entries: unknown[]): string {
  return JSON.stringify(entries);
}

function processEntry(name = 'worker', out = outputPath, error = errorPath) {
  return { name, pm2_env: { pm_out_log_path: out, pm_err_log_path: error } };
}

function setup(stdout = pm2List([processEntry()])) {
  const executePm2 = vi.fn().mockResolvedValue({ stdout, stderr: '' });
  const tail = {
    read: vi.fn().mockResolvedValue({
      lines: [Buffer.from('\u001b[31mline\u001b[0m')],
      truncatedByByteLimit: false,
    }),
  };
  const adapter = new Pm2ApplicationLogReaderAdapter({
    executePm2,
    tail: tail as never,
    environment: {
      HOME: '/home/pi',
      PM2_HOME: '/home/pi/.pm2',
      PM2_APP_NAME: 'worker',
      TELEGRAM_BOT_TOKEN: '123456789:abcdefghijklmnopqrstuvwxyzABCDE_123456789',
      UNRELATED_SECRET: 'not-forwarded-to-child',
    },
  });
  return { adapter, executePm2, tail };
}

describe('Pm2ApplicationLogReaderAdapter', () => {
  it.each([
    ['output', outputPath],
    ['error', errorPath],
  ] as const)('selects only the %s path', async (stream, expectedPath) => {
    const { adapter, tail } = setup();
    await expect(adapter.read(stream, { maxLines: 200, maxBytes: 2 * 1024 * 1024 }))
      .resolves.toMatchObject({ stream, lines: ['line'] });
    expect(tail.read).toHaveBeenCalledWith({
      path: expectedPath,
      maxLines: 200,
      maxBytes: 2 * 1024 * 1024,
    });
  });

  it('runs bounded pm2 jlist with no secret-bearing environment', async () => {
    const { adapter, executePm2 } = setup();
    await adapter.read('output', { maxLines: 200, maxBytes: 1024 });
    expect(executePm2).toHaveBeenCalledWith('pm2', ['jlist'], {
      encoding: 'utf8',
      env: {
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        HOME: '/home/pi',
        PM2_HOME: '/home/pi/.pm2',
      },
      timeout: 5_000,
      maxBuffer: 2 * 1024 * 1024,
      shell: false,
    });
  });

  it.each([
    ['malformed JSON', '{', 'pm2-metadata-invalid'],
    ['non-array JSON', '{}', 'pm2-metadata-invalid'],
    ['zero exact matches', pm2List([processEntry('other')]), 'process-not-found'],
    ['multiple exact matches', pm2List([processEntry(), processEntry()]), 'process-ambiguous'],
    ['missing pm2_env', pm2List([{ name: 'worker' }]), 'stream-path-invalid'],
    ['relative path', pm2List([processEntry('worker', 'relative.log')]), 'stream-path-invalid'],
    ['combined paths', pm2List([processEntry('worker', outputPath, outputPath)]), 'stream-path-collision'],
  ] as const)('fails closed for %s', async (_label, stdout, reason) => {
    const { adapter, tail } = setup(stdout);
    await expect(adapter.read('output', { maxLines: 200, maxBytes: 1024 }))
      .rejects.toMatchObject({ reason });
    expect(tail.read).not.toHaveBeenCalled();
  });

  it('discards a secret-bearing PM2 execution error', async () => {
    const secret = `metadata ${outputPath} token-value`;
    const executePm2 = vi.fn().mockRejectedValue(new Error(secret));
    const adapter = new Pm2ApplicationLogReaderAdapter({ executePm2 });
    const failure = await adapter.read('output', { maxLines: 200, maxBytes: 1024 })
      .catch((error: unknown) => error);
    expect(failure).toEqual(new ApplicationLogUnavailableError('pm2-unavailable'));
    expect(`${String(failure)}\n${(failure as Error).stack ?? ''}`).not.toContain(secret);
    expect(`${String(failure)}\n${(failure as Error).stack ?? ''}`).not.toContain(outputPath);
  });

  it('preserves raw-tail truncation after sanitization', async () => {
    const { adapter, tail } = setup();
    tail.read.mockResolvedValue({
      lines: [Buffer.from('newest')],
      truncatedByByteLimit: true,
    });
    await expect(adapter.read('error', { maxLines: 200, maxBytes: 1024 }))
      .resolves.toMatchObject({ truncatedByByteLimit: true });
  });

  it('preserves typed file-boundary failures', async () => {
    const { adapter, tail } = setup();
    const failure = new ApplicationLogUnavailableError('snapshot-changed');
    tail.read.mockRejectedValue(failure);

    await expect(adapter.read('output', { maxLines: 200, maxBytes: 1024 })).rejects.toBe(failure);
  });

  it('maps an unknown file-boundary failure without retaining its value', async () => {
    const secret = `file ${outputPath} token-value`;
    const { adapter, tail } = setup();
    tail.read.mockRejectedValue(new Error(secret));

    const failure = await adapter.read('output', { maxLines: 200, maxBytes: 1024 })
      .catch((error: unknown) => error);
    expect(failure).toEqual(new ApplicationLogUnavailableError('file-unavailable'));
    expect(`${String(failure)}\n${(failure as Error).stack ?? ''}`).not.toContain(secret);
    expect(`${String(failure)}\n${(failure as Error).stack ?? ''}`).not.toContain(outputPath);
  });
});
