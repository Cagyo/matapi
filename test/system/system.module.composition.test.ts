import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ReadApplicationLogsUseCase } from '../../src/system/application/read-application-logs.use-case';
import { APPLICATION_LOG_READER } from '../../src/system/domain/ports/application-log-reader.port';
import { SystemModule } from '../../src/system/system.module';

describe('SystemModule application-log composition', () => {
  it('binds the application-log reader and exports only the application use case', () => {
    const providers = Reflect.getMetadata('providers', SystemModule) as unknown[];
    const exports = Reflect.getMetadata('exports', SystemModule) as unknown[];
    expect(providers).toEqual(expect.arrayContaining([
      ReadApplicationLogsUseCase,
      expect.objectContaining({ provide: APPLICATION_LOG_READER }),
    ]));
    expect(exports).toContain(ReadApplicationLogsUseCase);
    expect(exports).not.toContain(APPLICATION_LOG_READER);
  });
});
