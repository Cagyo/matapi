import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterEach, describe, expect, it } from 'vitest';
import { ShellOtaAdapter } from '../../../src/system/infrastructure/shell-ota.adapter';
import { OTA } from '../../../src/system/domain/ports/ota.port';

@Module({ providers: [{ provide: OTA, useClass: ShellOtaAdapter }] })
class OtaDiTestModule {}

describe('ShellOtaAdapter DI wiring', () => {
  let app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>> | null =
    null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it('resolves via Nest useClass without an explicit exec provider', async () => {
    app = await NestFactory.createApplicationContext(OtaDiTestModule, {
      logger: false,
    });
    const adapter = app.get(OTA);
    expect(adapter).toBeInstanceOf(ShellOtaAdapter);
  });
});
