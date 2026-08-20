import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Extracts one shell function definition verbatim from scripts/update.sh. */
function updateFunction(name: string): string {
  const script = readFileSync(resolve('scripts/update.sh'), 'utf8');
  const match = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}$`, 'm').exec(script);

  expect(match, `scripts/update.sh no longer defines ${name}()`).not.toBeNull();

  return match?.[0] ?? '';
}

interface RestartAttempt {
  /** Every pm2 command line the fake pm2 was invoked with. */
  commands: string[];
  /** The environment the last pm2 invocation saw. */
  environment: Record<string, string>;
}

/** Runs update.sh's restart_worker() against a fake pm2 in a throwaway install. */
function runRestartWorker(ecosystemSource: string, appName: string): RestartAttempt {
  const tempDir = mkdtempSync(join(tmpdir(), 'home-worker-update-restart-'));
  try {
    const installDir = join(tempDir, 'install');
    const fakeBin = join(tempDir, 'bin');
    mkdirSync(installDir, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(join(installDir, 'ecosystem.config.js'), ecosystemSource);

    const commandLog = join(tempDir, 'pm2.commands');
    const environmentDump = join(tempDir, 'pm2.env');
    // Absolute paths baked in: restart_worker scrubs the environment, so the
    // fake cannot be told where to record through a variable.
    writeFileSync(
      join(fakeBin, 'pm2'),
      [
        '#!/bin/sh',
        `printf '%s\\n' "$*" >> ${JSON.stringify(commandLog)}`,
        `env > ${JSON.stringify(environmentDump)}`,
        'exit 0',
        '',
      ].join('\n'),
    );
    chmodSync(join(fakeBin, 'pm2'), 0o755);
    writeFileSync(commandLog, '');
    writeFileSync(environmentDump, '');

    const harness = join(tempDir, 'restart.sh');
    writeFileSync(
      harness,
      [
        '#!/bin/bash',
        'set -euo pipefail',
        `export PATH=${JSON.stringify(fakeBin)}:"$PATH"`,
        `INSTALL_DIR=${JSON.stringify(installDir)}`,
        `APP_NAME=${JSON.stringify(appName)}`,
        updateFunction('ecosystem_declares_app'),
        updateFunction('restart_worker'),
        'restart_worker',
        '',
      ].join('\n'),
    );
    chmodSync(harness, 0o755);

    execFileSync('bash', [harness], {
      encoding: 'utf8',
      env: {
        ...process.env,
        // Two of the OTA control knobs update.sh carries in its own environment.
        DATABASE_PATH: '/ota/scratch/worker.db',
        NODE_OPTIONS: '--max-old-space-size=512',
        PM2_HOME: '/home/homeworker/.pm2',
      },
    });

    const environment: Record<string, string> = {};
    for (const line of readFileSync(environmentDump, 'utf8').split('\n')) {
      const separator = line.indexOf('=');
      if (separator > 0) environment[line.slice(0, separator)] = line.slice(separator + 1);
    }

    return {
      commands: readFileSync(commandLog, 'utf8').split('\n').filter(Boolean),
      environment,
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

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

/** Evaluates update.sh's post-restart crash-counter guard for one pair of readings. */
function rollsBackOnRestartCount(baseline: string, count: string): boolean {
  const script = readFileSync(resolve('scripts/update.sh'), 'utf8');
  const match =
    /\nif \[\[ "\$RESTART_BASELINE" =~[\s\S]*?\(\( RESTART_COUNT > RESTART_BASELINE \+ 1 \)\); then/.exec(
      script,
    );

  expect(match, 'scripts/update.sh no longer guards on the PM2 restart counter').not.toBeNull();

  const condition = (match?.[0] ?? '').replace(/^\nif /, '').replace(/; then$/, '');
  const evaluated = spawnSync('bash', ['-c', `set -euo pipefail\nif ${condition}; then exit 0; fi\nexit 1`], {
    env: { ...process.env, RESTART_BASELINE: baseline, RESTART_COUNT: count },
  });

  expect(evaluated.status, String(evaluated.stderr)).not.toBeNull();
  return evaluated.status === 0;
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
    const parser = updateFunction('pm2_app_state');

    expect(parser).toContain('| APP_NAME="$APP_NAME" node -e');
    // Both readings degrade to a non-numeric sentinel so a `pm2 jlist` hiccup
    // can never look like a restart and trigger a rollback on its own.
    expect(parser).toContain("'missing unknown'");
    expect(parser).toContain('echo "unknown unknown"');
  });

  it('restarts from ecosystem.config.js so an updated PM2 restart policy takes effect', () => {
    // `pm2 restart <name>` replays the stored pm2_env and never re-reads the
    // config file, so min_uptime/restart_delay/max_restarts shipped by an update
    // would never reach the device (spec 23 -> Crash-Loop Protection).
    const attempt = runRestartWorker(
      readFileSync(resolve('ecosystem.config.js'), 'utf8'),
      'worker',
    );

    expect(attempt.commands).toHaveLength(1);
    expect(attempt.commands[0]).toMatch(
      /^startOrRestart \S+\/ecosystem\.config\.js --update-env --only worker$/,
    );
  });

  it('scrubs the OTA environment out of the restart so it is not baked into pm2_env', () => {
    // The config-file path forces PM2 to update the app's environment from the
    // caller's, and `pm2 save` persists it. dotenv never overrides an already
    // set variable, so a leaked DATABASE_PATH would shadow .env permanently.
    const attempt = runRestartWorker(
      readFileSync(resolve('ecosystem.config.js'), 'utf8'),
      'worker',
    );

    expect(attempt.environment.DATABASE_PATH).toBeUndefined();
    expect(attempt.environment.NODE_OPTIONS).toBeUndefined();
    expect(attempt.environment.PATH).toBeTruthy();
    // PM2's own locators must survive, or the restart addresses a different
    // daemon than the health check queries and `--only` silently matches nothing.
    expect(attempt.environment.PM2_HOME).toBe('/home/homeworker/.pm2');
    expect(attempt.environment.HOME).toBeTruthy();
  });

  it('falls back to a by-name restart when the config file declares no such app', () => {
    // `--only` with an undeclared name restarts nothing and still exits 0, which
    // would leave the health check sampling the stale-but-online process.
    const attempt = runRestartWorker(
      "module.exports = { apps: [{ name: 'something-else', script: 'dist/main.js' }] };\n",
      'worker',
    );

    expect(attempt.commands).toEqual(['restart worker']);
  });

  it('tolerates the update restart itself but rolls back on a crash during the check', () => {
    // A crash-looping build reads `online` for most of each restart_delay cycle,
    // so the status sample alone misses it; the counter does not.
    expect(rollsBackOnRestartCount('4', '5')).toBe(false);
    expect(rollsBackOnRestartCount('4', '4')).toBe(false);
    expect(rollsBackOnRestartCount('4', '6')).toBe(true);
    expect(rollsBackOnRestartCount('0', '3')).toBe(true);
  });

  it('never rolls back on a reading pm2 failed to produce', () => {
    expect(rollsBackOnRestartCount('unknown', 'unknown')).toBe(false);
    expect(rollsBackOnRestartCount('4', 'unknown')).toBe(false);
    expect(rollsBackOnRestartCount('unknown', '9')).toBe(false);
    expect(rollsBackOnRestartCount('', '')).toBe(false);
  });

  it('saves the PM2 process list only after the health check has passed', () => {
    const script = readFileSync(resolve('scripts/update.sh'), 'utf8');
    const statusCheck = script.indexOf('Health check failed (pm2 status=$STATUS)');
    const restartCheck = script.indexOf('RESTART_COUNT > RESTART_BASELINE + 1');
    const save = script.indexOf('\npm2 save >/dev/null');

    expect(statusCheck).toBeGreaterThan(-1);
    expect(restartCheck).toBeGreaterThan(statusCheck);
    expect(save).toBeGreaterThan(restartCheck);
    expect(script.indexOf('write_meta "update_status" "success"')).toBeGreaterThan(save);
  });

  it('checks the fetched helper requirement before resetting to a candidate commit', () => {
    const script = readFileSync(resolve('scripts/update.sh'), 'utf8');
    const candidateCheck = script.indexOf('require_feature_helper_version "$CANDIDATE_HELPER_VERSION"');
    const reset = script.indexOf('git reset --hard "origin/$BRANCH"');
    expect(candidateCheck).toBeGreaterThan(-1);
    expect(reset).toBeGreaterThan(candidateCheck);
  });
});
