import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { resolve } from 'node:path';
import { AppModule } from './app.module';
import { GracefulShutdownService } from './system/application/graceful-shutdown.service';
import { PidLockGateway } from './system/infrastructure/pid-lock.gateway';

const lock = new PidLockGateway(resolve(process.env.PID_LOCK_PATH || './data/worker.pid'));

async function bootstrap(): Promise<void> {
  lock.acquire();

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
      Logger.warn(`Graceful shutdown step failed: ${(err as Error).message}`, 'Bootstrap');
    }
    // Nest then destroys modules: stops the bot runner, flushes sensor
    // buffers and closes SQLite last (DatabaseModule is global / init-first).
    await app.close();
    lock.release();
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
  lock.release();
  process.exit(1);
});
