import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ReadApplicationLogsUseCase } from '../../src/system/application/read-application-logs.use-case';
import { APPLICATION_LOG_READER } from '../../src/system/domain/ports/application-log-reader.port';
import { Pm2ApplicationLogReaderAdapter } from '../../src/system/infrastructure/pm2-application-log-reader.adapter';
import { SystemModule } from '../../src/system/system.module';

describe('SystemModule application-log composition', () => {
  it('binds the application-log reader and exports only the application use case', () => {
    const providers = Reflect.getMetadata('providers', SystemModule) as unknown[];
    const exports = Reflect.getMetadata('exports', SystemModule) as unknown[];
    const readerProvider = providers.find(
      (provider): provider is { provide: symbol; useFactory: () => unknown } => (
        typeof provider === 'object'
        && provider !== null
        && 'provide' in provider
        && provider.provide === APPLICATION_LOG_READER
        && 'useFactory' in provider
        && typeof provider.useFactory === 'function'
      ),
    );

    expect(providers).toContain(ReadApplicationLogsUseCase);
    expect(readerProvider).toBeDefined();
    expect(readerProvider?.useFactory()).toBeInstanceOf(Pm2ApplicationLogReaderAdapter);
    expect(exports).toContain(ReadApplicationLogsUseCase);
    expect(exports).not.toContain(APPLICATION_LOG_READER);
    expect(exports).not.toContain(Pm2ApplicationLogReaderAdapter);
  });
});
