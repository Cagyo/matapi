import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { AppModule } from './app.module';

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
    await app.close();
    releaseLock();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.init();
  Logger.log(`Home Worker started (pid ${process.pid})`, 'Bootstrap');
}

bootstrap().catch((err: unknown) => {
  Logger.error(err instanceof Error ? (err.stack ?? err.message) : String(err), 'Bootstrap');
  releaseLock();
  process.exit(1);
});
