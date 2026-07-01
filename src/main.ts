import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { AppModule } from './app.module';
import { GracefulShutdownService } from './system/application/graceful-shutdown.service';

const PID_LOCK = resolve(process.env.PID_LOCK_PATH || './data/worker.pid');

function acquireLock(): void {
  mkdirSync(dirname(PID_LOCK), { recursive: true });
  if (existsSync(PID_LOCK)) {
    const oldPid = Number(readFileSync(PID_LOCK, 'utf8').trim());
    if (oldPid && processAlive(oldPid)) {
      throw new Error(`Worker already running (pid ${oldPid})`);
    }
  }
  writeFileSync(PID_LOCK, String(process.pid));
}

function releaseLock(): void {
  try {
    unlinkSync(PID_LOCK);
  } catch {
    // ignore
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function bootstrap(): Promise<void> {
  acquireLock();

  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'warn', 'error', 'debug'],
  });
  app.enableShutdownHooks();

  const shutdown = async (signal: string): Promise<void> => {
    Logger.log(`Received ${signal}, shutting down`, 'Bootstrap');
    // Ordered graceful teardown while the bot is still polling (spec 23):
    // stop accepting events, drain in-flight work, send the offline notice.
    try {
      await app.get(GracefulShutdownService).run(signal);
    } catch (err) {
      Logger.warn(
        `Graceful shutdown step failed: ${(err as Error).message}`,
        'Bootstrap',
      );
    }
    // Nest then destroys modules: stops the bot runner, flushes sensor
    // buffers and closes SQLite last (DatabaseModule is global / init-first).
    await app.close();
    releaseLock();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  const hookPort = Number(process.env.MOTION_HOOK_PORT || process.env.PORT) || 4000;
  // Bind to loopback only — the Motion daemon runs on the same host and the
  // hook routes must never be reachable off-box (spec 20).
  await app.listen(hookPort, '127.0.0.1');
  Logger.log(
    `Home Worker started (pid ${process.pid}), motion hooks on 127.0.0.1:${hookPort}`,
    'Bootstrap',
  );
}

bootstrap().catch((err: unknown) => {
  Logger.error(err instanceof Error ? (err.stack ?? err.message) : String(err), 'Bootstrap');
  releaseLock();
  process.exit(1);
});
