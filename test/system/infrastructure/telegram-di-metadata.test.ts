import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

function emittedParamTypes(path: string): string {
  return ts.transpileModule(readFileSync(resolve(path), 'utf8'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
    },
  }).outputText;
}

describe('Telegram role-use-case dependency metadata', () => {
  it.each([
    'src/telegram/application/promote-user.use-case.ts',
    'src/telegram/application/demote-user.use-case.ts',
  ])('%s emits ResolveUserTargetUseCase for Nest injection', (path) => {
    expect(emittedParamTypes(path)).toMatch(
      /design:paramtypes".*ResolveUserTargetUseCase/,
    );
  });

  it('does not emit a phantom constructor dependency for the CSV temp-file adapter', () => {
    const emitted = emittedParamTypes(
      'src/telegram/infrastructure/node-csv-temp-file.adapter.ts',
    );

    expect(emitted).not.toMatch(/design:paramtypes".*\[Object\]/);
    expect(emitted).toContain('CSV_TEMP_DIRECTORY');
  });

  it('injects the camera-source handler clock through the CLOCK token', () => {
    const emitted = emittedParamTypes('src/telegram/interfaces/camera-sources.handler.ts');

    expect(emitted).toMatch(/__param\(3,.*CLOCK/);
  });
});
