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

function moduleExports(path: string): string[] {
  const source = readFileSync(resolve(path), 'utf8');
  const match = /exports:\s*\[([\s\S]*?)\],\s*\}\)\s*\nexport class FeatureModule/u.exec(source);
  if (!match) throw new Error(`Unable to find FeatureModule exports in ${path}`);
  return match[1].split(',').map((entry) => entry.trim()).filter(Boolean);
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

    // Position-agnostic on purpose: the guard is that the clock arrives through
    // the token rather than as a concrete class, not where it sits in the list.
    expect(emitted).toMatch(/__param\(\d+,.*CLOCK/);
  });

  it('keeps Home on port-based dependencies and TelegramModule free of forwardRef wiring', () => {
    const home = emittedParamTypes('src/telegram/interfaces/home.handler.ts');
    const module = readFileSync(resolve('src/telegram/telegram.module.ts'), 'utf8');

    expect(home).not.toContain('LegacyMenuHandler');
    expect(home).not.toContain('DrizzleHomeActionRepository');
    expect(module).not.toContain('forwardRef(');
  });

  it('exports only FeatureModule ports and use cases consumed across context boundaries', () => {
    expect(moduleExports('src/features/feature.module.ts')).toEqual([
      'FEATURE_QUERY',
      // Camera grants and install recovery must judge the installed policy from
      // the same verified projection, so the port crosses the context boundary.
      'RTSP_POLICY_STATUS',
      'FEATURE_AVAILABILITY',
      'FEATURE_RUNTIME_LIFECYCLE',
      'FEATURE_INSTALL_OUTCOME_REGISTRY',
      'EnableFeatureUseCase',
      'DisableFeatureUseCase',
      'ListManageableFeaturesUseCase',
      'GetFeatureDetailUseCase',
      'BeginFeatureInstallUseCase',
      'VerifyFeatureReadinessUseCase',
    ]);
  });

  it.each([
    'src/sensors/sensor.module.ts',
    'src/camera/camera.module.ts',
    'src/telegram/telegram.module.ts',
  ])('%s imports FeatureModule without circular forwardRef wiring', (path) => {
    const source = readFileSync(resolve(path), 'utf8');

    expect(source).toContain("from '../features/feature.module'");
    expect(source).not.toContain('forwardRef(');
  });
});
