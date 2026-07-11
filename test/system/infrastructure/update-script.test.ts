import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function normalizeRepositoryUrl(repositoryUrl: string): string {
  const script = readFileSync(resolve('scripts/update.sh'), 'utf8');
  const assignment = script
    .split('\n')
    .find((line) => line.startsWith('  CLEAN_URL='));

  expect(assignment).toBeDefined();

  return execFileSync(
    'bash',
    ['-c', `${assignment}; printf '%s' "$CLEAN_URL"`],
    { env: { ...process.env, REPO_URL: repositoryUrl }, encoding: 'utf8' },
  );
}

function resolveDatabasePath(installDir: string): string {
  const script = readFileSync(resolve('scripts/update.sh'), 'utf8');
  const match = /configured_database_path\(\) \{\n([\s\S]*?)\n\}/.exec(script);

  expect(match).not.toBeNull();

  return execFileSync(
    'bash',
    ['-c', `INSTALL_DIR="$1"; ${match?.[0] ?? ''}; configured_database_path`, '--', installDir],
    { encoding: 'utf8' },
  ).trim();
}

describe('update.sh repository URL normalization', () => {
  it('converts an SSH GitHub remote to an HTTPS repository URL', () => {
    expect(normalizeRepositoryUrl('git@github.com:me/home-worker.git')).toBe(
      'https://github.com/me/home-worker',
    );
  });

  it('uses DATABASE_PATH from the installed .env when the environment omits it', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'home-worker-update-'));
    writeFileSync(join(installDir, '.env'), 'DATABASE_PATH=/var/lib/home-worker/dev.db\n');

    try {
      expect(resolveDatabasePath(installDir)).toBe('/var/lib/home-worker/dev.db');
    } finally {
      rmSync(installDir, { force: true, recursive: true });
    }
  });

  it('passes the PM2 app name to the health-check parser', () => {
    const script = readFileSync(resolve('scripts/update.sh'), 'utf8');
    const healthCheck = script
      .split('\n')
      .find((line) => line.startsWith('STATUS='));

    expect(healthCheck).toContain('| APP_NAME="$APP_NAME" node -e');
  });
});
