import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { constants } from 'node:fs';
import { Logger } from '@nestjs/common';
import { DigitalReadinessAdapter } from '../../../src/features/infrastructure/readiness/digital-readiness.adapter';
import { MotionReadinessAdapter } from '../../../src/features/infrastructure/readiness/motion-readiness.adapter';
import { RtspReadinessAdapter } from '../../../src/features/infrastructure/readiness/rtsp-readiness.adapter';
import { UartReadinessAdapter } from '../../../src/features/infrastructure/readiness/uart-readiness.adapter';
import { ZigbeeReadinessAdapter } from '../../../src/features/infrastructure/readiness/zigbee-readiness.adapter';

describe('feature readiness adapters', () => {
  beforeEach(() => {
    delete process.env.GPIO_CHIP;
  });
  afterEach(() => {
    delete process.env.GPIO_CHIP;
  });

  it('digital readiness passes when gpiod tools, chip, group and chip access hold and pigpiod is absent', async () => {
    const execFile = vi.fn(async (executable: string, args: readonly string[]) => {
      if (executable === '/usr/bin/which') return { stdout: `/usr/bin/${args[0]}\n`, stderr: '' };
      if (executable === '/usr/bin/gpiodetect') {
        return { stdout: 'gpiochip0 [pinctrl-rp1] (54 lines)\n', stderr: '' };
      }
      if (executable === '/usr/bin/id') return { stdout: 'homeworker gpio video\n', stderr: '' };
      if (executable === '/bin/systemctl') throw new Error('inactive'); // pigpiod must NOT be active
      throw new Error(`unexpected exec: ${executable}`);
    });
    const openReadWrite = vi.fn().mockResolvedValue(undefined);
    const adapter = new DigitalReadinessAdapter({ execFile, files: { openReadWrite } });

    await expect(adapter.verify('digital')).resolves.toEqual({ ready: true, restartScope: 'worker' });
    // The probe opens the chardev itself — it never shells out to gpioinfo, whose
    // all-chips dump overflowed the fixed-command buffer on a Pi 5.
    expect(openReadWrite).toHaveBeenCalledWith('/dev/gpiochip0');
  });

  it('digital readiness fails when the worker lacks the gpio group', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const execFile = vi.fn(async (executable: string, args: readonly string[]) => {
      if (executable === '/usr/bin/which') return { stdout: `/usr/bin/${args[0]}\n`, stderr: '' };
      if (executable === '/usr/bin/gpiodetect') {
        return { stdout: 'gpiochip0 [pinctrl-bcm2711] (58 lines)\n', stderr: '' };
      }
      if (executable === '/usr/bin/id') return { stdout: 'homeworker video\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const openReadWrite = vi.fn().mockResolvedValue(undefined);
    const adapter = new DigitalReadinessAdapter({ execFile, files: { openReadWrite } });

    await expect(adapter.verify('digital')).resolves.toEqual({
      ready: false,
      failureCode: 'application-verification-failed',
    });
    expect(openReadWrite).not.toHaveBeenCalled(); // group check short-circuits before the open
  });

  it('digital readiness fails while pigpiod is still active — it fights gpiod invisibly', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const execFile = vi.fn(async (executable: string, args: readonly string[]) => {
      if (executable === '/usr/bin/which') return { stdout: `/usr/bin/${args[0]}\n`, stderr: '' };
      if (executable === '/usr/bin/gpiodetect') {
        return { stdout: 'gpiochip0 [pinctrl-bcm2835] (54 lines)\n', stderr: '' };
      }
      if (executable === '/usr/bin/id') return { stdout: 'homeworker gpio\n', stderr: '' };
      if (executable === '/bin/systemctl') return { stdout: 'active\n', stderr: '' };
      throw new Error(`unexpected exec: ${executable}`);
    });
    const openReadWrite = vi.fn().mockResolvedValue(undefined);
    const adapter = new DigitalReadinessAdapter({ execFile, files: { openReadWrite } });

    await expect(adapter.verify('digital')).resolves.toEqual({
      ready: false,
      failureCode: 'application-verification-failed',
    });
    expect(openReadWrite).toHaveBeenCalledWith('/dev/gpiochip0');
  });

  it('digital readiness fails when the gpio chardev cannot be opened read-write', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const execFile = vi.fn(async (executable: string, args: readonly string[]) => {
      if (executable === '/usr/bin/which') return { stdout: `/usr/bin/${args[0]}\n`, stderr: '' };
      if (executable === '/usr/bin/gpiodetect') {
        return { stdout: 'gpiochip0 [pinctrl-rp1] (54 lines)\n', stderr: '' };
      }
      if (executable === '/usr/bin/id') return { stdout: 'homeworker gpio\n', stderr: '' };
      if (executable === '/bin/systemctl') throw new Error('inactive');
      throw new Error(`unexpected exec: ${executable}`);
    });
    const openReadWrite = vi.fn().mockRejectedValue(
      Object.assign(new Error('EACCES: permission denied, open \'/dev/gpiochip0\''), { code: 'EACCES' }),
    );
    const adapter = new DigitalReadinessAdapter({ execFile, files: { openReadWrite } });

    await expect(adapter.verify('digital')).resolves.toEqual({
      ready: false,
      failureCode: 'application-verification-failed',
    });
    expect(openReadWrite).toHaveBeenCalledWith('/dev/gpiochip0');
  });

  it('digital readiness opens the GPIO_CHIP override even when another chip carries a known label', async () => {
    process.env.GPIO_CHIP = 'gpiochip4';
    const execFile = vi.fn(async (executable: string, args: readonly string[]) => {
      if (executable === '/usr/bin/which') return { stdout: `/usr/bin/${args[0]}\n`, stderr: '' };
      if (executable === '/usr/bin/gpiodetect') {
        return {
          stdout: 'gpiochip0 [pinctrl-rp1] (54 lines)\ngpiochip4 [gpio-brcmstb] (32 lines)\n',
          stderr: '',
        };
      }
      if (executable === '/usr/bin/id') return { stdout: 'homeworker gpio\n', stderr: '' };
      if (executable === '/bin/systemctl') throw new Error('inactive');
      throw new Error(`unexpected exec: ${executable}`);
    });
    const openReadWrite = vi.fn().mockResolvedValue(undefined);
    const adapter = new DigitalReadinessAdapter({ execFile, files: { openReadWrite } });

    await expect(adapter.verify('digital')).resolves.toEqual({ ready: true, restartScope: 'worker' });
    // Must match resolveChip() in libgpiod-cli.syntax.ts, or readiness would green-light
    // gpiochip0 while gpiomon drives gpiochip4.
    expect(openReadWrite).toHaveBeenCalledWith('/dev/gpiochip4');
  });

  it('digital readiness fails when GPIO_CHIP matches no detected chip', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    process.env.GPIO_CHIP = 'gpiochip9';
    // Everything except the chip resolution is healthy on purpose: only then does
    // the case discriminate between override-first and label-first precedence.
    const execFile = vi.fn(async (executable: string, args: readonly string[]) => {
      if (executable === '/usr/bin/which') return { stdout: `/usr/bin/${args[0]}\n`, stderr: '' };
      if (executable === '/usr/bin/gpiodetect') {
        return { stdout: 'gpiochip0 [pinctrl-rp1] (54 lines)\n', stderr: '' };
      }
      if (executable === '/usr/bin/id') return { stdout: 'homeworker gpio\n', stderr: '' };
      if (executable === '/bin/systemctl') throw new Error('inactive');
      throw new Error(`unexpected exec: ${executable}`);
    });
    const openReadWrite = vi.fn().mockResolvedValue(undefined);
    const adapter = new DigitalReadinessAdapter({ execFile, files: { openReadWrite } });

    await expect(adapter.verify('digital')).resolves.toEqual({
      ready: false,
      failureCode: 'application-verification-failed',
    });
    // No silent fallback to the known label — resolveChip() throws here, so readiness fails here.
    expect(openReadWrite).not.toHaveBeenCalled();
  });

  it('maps a failed fixed command to the allowlisted application failure', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const adapter = new ZigbeeReadinessAdapter({ execFile: vi.fn().mockRejectedValue(new Error('not installed')) });

    await expect(adapter.verify('zigbee')).resolves.toEqual({ ready: false, failureCode: 'application-verification-failed' });
  });

  it('checks UART boot configuration, inactive disabled console, and worker device access through seams', async () => {
    const execFile = vi.fn().mockResolvedValue({ stdout: 'LoadState=loaded\nUnitFileState=disabled\nActiveState=inactive\n', stderr: '' });
    const openReadWrite = vi.fn().mockResolvedValue(undefined);
    const adapter = new UartReadinessAdapter({
      execFile,
      files: {
        readFile: vi.fn((path: string) => {
          if (path.endsWith('config.txt')) return Promise.resolve('enable_uart=1\n');
          return Promise.resolve('root=PARTUUID=123 quiet\n');
        }),
        openReadWrite,
      },
      serialDevice: '/dev/serial0',
    });

    await expect(adapter.verify('uart')).resolves.toEqual({ ready: true, restartScope: 'worker' });
    expect(execFile).toHaveBeenCalledWith('/bin/systemctl', ['show', 'serial-getty@serial0.service', '--property=LoadState,UnitFileState,ActiveState'], expect.objectContaining({ timeout: 5_000, maxBuffer: 65_536 }));
    expect(execFile).toHaveBeenCalledWith('/bin/systemctl', ['show', 'serial-getty@ttyAMA0.service', '--property=LoadState,UnitFileState,ActiveState'], expect.anything());
    expect(execFile).toHaveBeenCalledWith('/bin/systemctl', ['show', 'serial-getty@ttyS0.service', '--property=LoadState,UnitFileState,ActiveState'], expect.anything());
    expect(execFile).toHaveBeenCalledWith('/bin/systemctl', ['show', 'serial-getty@ttyAMA10.service', '--property=LoadState,UnitFileState,ActiveState'], expect.anything());
    expect(openReadWrite).toHaveBeenCalledWith('/dev/serial0');
  });

  it('rejects UART readiness when an installer-managed serial getty alias is enabled', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const execFile = vi.fn().mockImplementation((_executable: string, arguments_: readonly string[]) => Promise.resolve({
      stdout: arguments_[1] === 'serial-getty@ttyAMA10.service' ? 'LoadState=loaded\nUnitFileState=enabled\nActiveState=inactive\n' : 'LoadState=loaded\nUnitFileState=disabled\nActiveState=inactive\n',
      stderr: '',
    }));
    const adapter = new UartReadinessAdapter({
      execFile,
      files: { readFile: vi.fn((path: string) => Promise.resolve(path.endsWith('config.txt') ? 'enable_uart=1\n' : 'quiet\n')), openReadWrite: vi.fn() },
    });

    await expect(adapter.verify('uart')).resolves.toEqual({ ready: false, failureCode: 'application-verification-failed' });
  });

  it('rejects UART readiness when the next-boot cmdline retains a serial console alias', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const adapter = new UartReadinessAdapter({
      execFile: vi.fn().mockResolvedValue({ stdout: 'LoadState=loaded\nUnitFileState=disabled\nActiveState=inactive\n', stderr: '' }),
      files: {
        readFile: vi.fn((path: string) => Promise.resolve(
          path.endsWith('config.txt') ? 'enable_uart=1\n'
            : path === '/proc/cmdline' ? 'quiet\n'
              : 'console=ttyAMA0,115200 rootwait\n',
        )),
        openReadWrite: vi.fn(),
      },
    });

    await expect(adapter.verify('uart')).resolves.toEqual({ ready: false, failureCode: 'application-verification-failed' });
  });

  it('rejects UART readiness when the active kernel cmdline retains a serial console alias', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const adapter = new UartReadinessAdapter({
      execFile: vi.fn().mockResolvedValue({ stdout: 'LoadState=loaded\nUnitFileState=disabled\nActiveState=inactive\n', stderr: '' }),
      files: {
        readFile: vi.fn((path: string) => Promise.resolve(
          path.endsWith('config.txt') ? 'enable_uart=1\n'
            : path === '/proc/cmdline' ? 'console=serial0,115200 rootwait\n'
              : 'quiet\n',
        )),
        openReadWrite: vi.fn(),
      },
    });

    await expect(adapter.verify('uart')).resolves.toEqual({ ready: false, failureCode: 'application-verification-failed' });
  });

  it('rejects UART readiness when a disabled serial getty remains active', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const execFile = vi.fn().mockImplementation((_executable: string, arguments_: readonly string[]) => Promise.resolve({
      stdout: arguments_[1] === 'serial-getty@ttyS0.service'
        ? 'LoadState=loaded\nUnitFileState=disabled\nActiveState=active\n'
        : 'LoadState=loaded\nUnitFileState=disabled\nActiveState=inactive\n',
      stderr: '',
    }));
    const adapter = new UartReadinessAdapter({
      execFile,
      files: { readFile: vi.fn((path: string) => Promise.resolve(path.endsWith('config.txt') ? 'enable_uart=1\n' : 'quiet\n')), openReadWrite: vi.fn() },
    });

    await expect(adapter.verify('uart')).resolves.toEqual({ ready: false, failureCode: 'application-verification-failed' });
  });

  it('rejects UART readiness when serial console state cannot be checked', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const adapter = new UartReadinessAdapter({
      execFile: vi.fn().mockRejectedValue(new Error('systemd unavailable')),
      files: { readFile: vi.fn().mockResolvedValue('enable_uart=1\n'), openReadWrite: vi.fn() },
    });

    await expect(adapter.verify('uart')).resolves.toEqual({ ready: false, failureCode: 'application-verification-failed' });
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
    expect(access).toHaveBeenCalledWith('/home/pi/motion/videos', constants.W_OK | constants.X_OK);
    expect(access).toHaveBeenCalledWith('/home/pi/motion/thumbnails', constants.W_OK | constants.X_OK);
  });

  it('rejects Motion config when commented or stale duplicate directives hide the effective settings', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const adapter = new MotionReadinessAdapter({
      execFile: vi.fn().mockResolvedValue({ stdout: 'motion video\n', stderr: '' }),
      files: {
        readFile: vi.fn().mockResolvedValue([
          '# target_dir /home/pi/motion/videos',
          'target_dir /tmp/stale',
          '# on_movie_end curl -s "http://localhost:4000/motion/movie-end?camera=%t&file=%f"',
          'on_movie_end curl -s "http://localhost:4000/motion/other"',
        ].join('\n')),
        access: vi.fn(),
      },
    });

    await expect(adapter.verify('motion')).resolves.toEqual({ ready: false, failureCode: 'application-verification-failed' });
  });

  it('rejects Motion readiness when media storage is not writable and traversable', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const access = vi.fn().mockRejectedValue(new Error('EACCES'));
    const adapter = new MotionReadinessAdapter({
      execFile: vi.fn().mockResolvedValue({ stdout: 'motion video\n', stderr: '' }),
      files: {
        readFile: vi.fn().mockResolvedValue('target_dir /home/pi/motion/videos\non_movie_end curl -s "http://localhost:4000/motion/movie-end?camera=%t&file=%f"'),
        access,
      },
    });

    await expect(adapter.verify('motion')).resolves.toEqual({ ready: false, failureCode: 'application-verification-failed' });
    expect(access).toHaveBeenCalledWith('/home/pi/motion/videos', constants.W_OK | constants.X_OK);
  });

  it('checks RTSP root artifacts, runtime directories, and worker group without host access', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const execFile = vi.fn().mockResolvedValue({ stdout: 'homeworker homeworker-stream\n', stderr: '' });
    const stat = vi.fn().mockResolvedValue({ uid: 0, gid: 0, mode: 0o100755, isDirectory: () => false });
    const adapter = new RtspReadinessAdapter({ execFile, files: { stat } });

    await expect(adapter.verify('rtsp')).resolves.toEqual({ ready: false, failureCode: 'application-verification-failed' });
    expect(execFile).toHaveBeenCalledWith('/usr/bin/which', ['cloudflared'], expect.anything());
    expect(stat).toHaveBeenCalled();
  });

  it('rejects RTSP runtime directories with an unexpected stream group id', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const execFile = vi.fn().mockImplementation((_executable: string, arguments_: readonly string[]) => {
      if (arguments_[0] === 'getent') return Promise.resolve({ stdout: 'homeworker-stream:x:987:\n', stderr: '' });
      if (arguments_[0] === '-nG') return Promise.resolve({ stdout: 'homeworker homeworker-stream\n', stderr: '' });
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    const stat = vi.fn((path: string) => Promise.resolve({
      uid: 0,
      gid: path.startsWith('/run/') ? 123 : 0,
      mode: path === '/run/home-worker' ? 0o40750
        : path.endsWith('live-stream-config') ? 0o42730
          : path.endsWith('live-stream-output') ? 0o43770
            : path.endsWith('live-stream-policy.json') ? 0o100600
              : path.includes('live-stream-') && !path.includes('systemd') && !path.includes('polkit') && !path.includes('tmpfiles') ? 0o100755
                : 0o100644,
      isDirectory: () => path.startsWith('/run/'),
    }));
    const adapter = new RtspReadinessAdapter({ execFile, files: { stat } });

    await expect(adapter.verify('rtsp')).resolves.toEqual({ ready: false, failureCode: 'application-verification-failed' });
    expect(execFile).toHaveBeenCalledWith('/usr/bin/getent', ['group', 'homeworker-stream'], expect.anything());
  });
});
