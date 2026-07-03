#!/usr/bin/env node
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { DevSeederService } from '../src/sensors/application/dev-seeder.service';

async function run(): Promise<void> {
  const reset = process.argv.includes('--reset');
  const hookPort = Number(process.env.MOTION_HOOK_PORT || process.env.PORT) || 4000;
  const url = `http://127.0.0.1:${hookPort}/dev/simulate/seed`;

  console.log(`[DevSeed] Attempting live reload via active dev server at ${url}...`);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reset }),
    });

    if (res.ok) {
      const data = (await res.json()) as Record<string, unknown>;
      console.log('[DevSeed] Successfully seeded active dev server:', data);
      return;
    }
  } catch {
    console.log('[DevSeed] Active dev server unreachable. Booting offline seeder...');
  }

  // Ensure dev/stub modes are set so offline seeding does not touch GPIO or telegram API
  process.env.NODE_ENV = 'development';
  process.env.BOT_MODE = 'mock';
  process.env.CAMERA_MODE = 'stub';
  process.env.SYSTEM_MODE = 'stub';
  process.env.PIGPIOD_ENABLED = 'false';

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const seeder = app.get(DevSeederService);
    const result = await seeder.seed({ reset });
    console.log('[DevSeed] Offline seeding completed successfully:', result);
  } finally {
    await app.close();
  }
}

run().catch((err: unknown) => {
  console.error('[DevSeed] Fatal error:', err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
