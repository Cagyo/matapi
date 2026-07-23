import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { DigitalReadinessAdapter } from '../../../src/features/infrastructure/readiness/digital-readiness.adapter';
import { MotionReadinessAdapter } from '../../../src/features/infrastructure/readiness/motion-readiness.adapter';
import { RtspReadinessAdapter } from '../../../src/features/infrastructure/readiness/rtsp-readiness.adapter';
import { UartReadinessAdapter } from '../../../src/features/infrastructure/readiness/uart-readiness.adapter';
import { ZigbeeReadinessAdapter } from '../../../src/features/infrastructure/readiness/zigbee-readiness.adapter';

describe('feature readiness adapters', () => {
  it('runs digital checks through fixed, bounded command and socket seams', async () => {
    const execFile = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const connect = vi.fn().mockResolvedValue(undefined);
    const adapter = new DigitalReadinessAdapter({ execFile, connect, host: '127.0.0.1', port: 8888 });

    await expect(adapter.verify('digital')).resolves.toEqual({ ready: true, restartScope: 'worker' });
    expect(execFile).toHaveBeenNthCalledWith(1, '/usr/bin/which', ['pigpiod'], expect.objectContaining({ timeout: 5_000, maxBuffer: 4_096, env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' } }));
    expect(execFile).toHaveBeenNthCalledWith(2, '/bin/systemctl', ['is-active', 'pigpiod.service'], expect.anything());
    expect(connect).toHaveBeenCalledWith('127.0.0.1', 8888);
  });

  it('maps a failed fixed command to the allowlisted application failure', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const adapter = new ZigbeeReadinessAdapter({ execFile: vi.fn().mockRejectedValue(new Error('not installed')) });

    await expect(adapter.verify('zigbee')).resolves.toEqual({ ready: false, failureCode: 'application-verification-failed' });
  });

  it('checks UART boot configuration, disabled console, and worker device access through seams', async () => {
    const execFile = vi.fn().mockRejectedValue(new Error('disabled'));
    const openReadWrite = vi.fn().mockResolvedValue(undefined);
    const adapter = new UartReadinessAdapter({
      execFile,
      files: { readFile: vi.fn().mockResolvedValue('enable_uart=1\n'), openReadWrite },
      serialDevice: '/dev/serial0',
    });

    await expect(adapter.verify('uart')).resolves.toEqual({ ready: true, restartScope: 'worker' });
    expect(execFile).toHaveBeenCalledWith('/bin/systemctl', ['is-enabled', 'serial-getty@serial0.service'], expect.objectContaining({ timeout: 5_000, maxBuffer: 4_096 }));
    expect(openReadWrite).toHaveBeenCalledWith('/dev/serial0');
  });

  it('requires Motion configuration, storage, service, and groups through fixed seams', async () => {
    const execFile = vi.fn().mockResolvedValue({ stdout: 'motion video\n', stderr: '' });
    const access = vi.fn().mockResolvedValue(undefined);
    const adapter = new MotionReadinessAdapter({
      execFile,
      files: { readFile: vi.fn().mockResolvedValue('target_dir /home/pi/motion/videos\non_movie_end curl -s "http://localhost:4000/motion/movie-end?camera=%t&file=%f"'), access },
    });

    await expect(adapter.verify('motion')).resolves.toEqual({ ready: true, restartScope: 'worker' });
    expect(execFile).toHaveBeenCalledWith('/bin/systemctl', ['is-active', 'motion.service'], expect.anything());
    expect(execFile).toHaveBeenCalledWith('/usr/bin/id', ['-nG'], expect.anything());
    expect(access).toHaveBeenCalledTimes(2);
  });

  it('checks RTSP root artifacts, runtime directories, and worker group without host access', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const execFile = vi.fn().mockResolvedValue({ stdout: 'homeworker homeworker-stream\n', stderr: '' });
    const stat = vi.fn().mockResolvedValue({ uid: 0, mode: 0o100755, isDirectory: () => false });
    const adapter = new RtspReadinessAdapter({ execFile, files: { stat } });

    await expect(adapter.verify('rtsp')).resolves.toEqual({ ready: false, failureCode: 'application-verification-failed' });
    expect(execFile).toHaveBeenCalledWith('/usr/bin/which', ['cloudflared'], expect.anything());
    expect(stat).toHaveBeenCalled();
  });
});
