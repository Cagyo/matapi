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
  /** Exit status of restart_worker() itself. */
  status: number | null;
}

/** Runs update.sh's restart_worker() against a fake pm2 in a throwaway install. */
function runRestartWorker(
  ecosystemSource: string,
  appName: string,
  pm2ExitCode = 0,
): RestartAttempt {
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
        `exit ${pm2ExitCode}`,
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

    // spawnSync, not execFileSync: a non-zero restart is a case under test.
    const run = spawnSync('bash', [harness], {
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
      status: run.status,
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/** Runs update.sh's pm2_app_state() against a fake pm2 with the given exit code. */
function runPm2AppState(pm2ExitCode: number): {
  stdout: string;
  baselineField: string;
  status: number | null;
} {
  const tempDir = mkdtempSync(join(tmpdir(), 'home-worker-update-state-'));
  try {
    const fakeBin = join(tempDir, 'bin');
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(join(fakeBin, 'pm2'), `#!/bin/sh\nexit ${pm2ExitCode}\n`);
    chmodSync(join(fakeBin, 'pm2'), 0o755);

    const harness = join(tempDir, 'state.sh');
    writeFileSync(
      harness,
      [
        '#!/bin/bash',
        'set -euo pipefail',
        `export PATH=${JSON.stringify(fakeBin)}:"$PATH"`,
        'APP_NAME=worker',
        updateFunction('pm2_app_state'),
        // Exactly how update.sh consumes it, including the command substitution
        // that would trip `set -e` on a non-zero pipeline.
        'BASELINE="$(pm2_app_state | cut -d\' \' -f2)"',
        'pm2_app_state',
        'printf \'\\n%s\' "$BASELINE"',
        '',
      ].join('\n'),
    );
    chmodSync(harness, 0o755);

    const run = spawnSync('bash', [harness], { encoding: 'utf8' });
    const [stdout = '', baselineField = ''] = String(run.stdout).split('\n');

    return { stdout, baselineField, status: run.status };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/** Runs a snapshot/restore sequence through update.sh's own shell functions. */
function runDatabaseSnapshotCycle(): {
  afterSnapshot: string;
  afterMutation: string;
  afterRestore: string;
  sidecarsRemoved: boolean;
} {
  const tempDir = mkdtempSync(join(tmpdir(), 'home-worker-update-db-'));
  try {
    const installDir = join(tempDir, 'install');
    mkdirSync(join(installDir, 'data', 'rollbacks'), { recursive: true });
    const databasePath = join(installDir, 'data', 'worker.db');
    const snapshotPath = join(installDir, 'data', 'rollbacks', 'db-1.db');

    // WAL mode with an open sidecar is the state a live worker leaves behind,
    // and the reason a plain `cp` of the main file is not a snapshot.
    execFileSync('sqlite3', [
      databasePath,
      'PRAGMA journal_mode=WAL; CREATE TABLE events (id integer primary key, legacy text); INSERT INTO events (id, legacy) VALUES (1, \'before\');',
    ]);

    const harness = join(tempDir, 'db.sh');
    writeFileSync(
      harness,
      [
        '#!/bin/bash',
        'set -euo pipefail',
        `INSTALL_DIR=${JSON.stringify(installDir)}`,
        `DB_PATH=${JSON.stringify(databasePath)}`,
        `SNAPSHOT=${JSON.stringify(snapshotPath)}`,
        updateFunction('snapshot_database'),
        updateFunction('restore_database'),
        'snapshot_database "$SNAPSHOT"',
        'sqlite3 "$SNAPSHOT" "SELECT legacy FROM events;"',
        // The migration this stands in for: a rebuild the old code cannot read.
        'sqlite3 "$DB_PATH" "UPDATE events SET legacy = \'after\'; ALTER TABLE events DROP COLUMN legacy;"',
        'sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM pragma_table_info(\'events\') WHERE name = \'legacy\';"',
        'restore_database "$SNAPSHOT"',
        // Checked before anything reopens the database: a WAL-mode connection
        // recreates the sidecars, which would mask the discard.
        'if [ -e "$DB_PATH-wal" ] || [ -e "$DB_PATH-shm" ]; then echo present; else echo absent; fi',
        'sqlite3 "$DB_PATH" "SELECT legacy FROM events;"',
        '',
      ].join('\n'),
    );
    chmodSync(harness, 0o755);

    const lines = execFileSync('bash', [harness], { encoding: 'utf8' }).trim().split('\n');

    return {
      afterSnapshot: lines[0] ?? '',
      afterMutation: lines[1] ?? '',
      sidecarsRemoved: lines[2] === 'absent',
      afterRestore: lines[3] ?? '',
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
    expect(parser).toContain("'unknown unknown'");
  });

  it('emits exactly one sentinel pair when pm2 cannot be read', () => {
    // A `|| echo` fallback next to the parser's own sentinel appended a second
    // reading to the first, so `cut -f2` saw "unknownunknown" rather than the
    // documented "unknown".
    const state = runPm2AppState(1);

    expect(state.stdout).toBe('unknown unknown');
    expect(state.baselineField).toBe('unknown');
    expect(state.status).toBe(0);
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

  it('reports a failed restart so the caller can roll back, on both branches', () => {
    // The `if ! restart_worker` guard exists for this; previously a failing
    // restart aborted under `set -e` with new code on disk and no rollback.
    expect(
      runRestartWorker(readFileSync(resolve('ecosystem.config.js'), 'utf8'), 'worker', 7).status,
    ).toBe(7);
    expect(
      runRestartWorker(
        "module.exports = { apps: [{ name: 'something-else', script: 'dist/main.js' }] };\n",
        'worker',
        7,
      ).status,
    ).toBe(7);
  });

  it('rolls back when the restart command itself fails', () => {
    const script = readFileSync(resolve('scripts/update.sh'), 'utf8');

    expect(script).toContain('if ! restart_worker; then');
    const guard = script.indexOf('if ! restart_worker; then');
    const rollback = script.indexOf('rollback_to_snapshot', guard);
    const sleep = script.indexOf('sleep "$HEALTH_CHECK_SEC"');

    expect(rollback).toBeGreaterThan(guard);
    expect(rollback).toBeLessThan(sleep);
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
    const save = script.indexOf('if pm2 save >/dev/null');

    expect(statusCheck).toBeGreaterThan(-1);
    expect(restartCheck).toBeGreaterThan(statusCheck);
    expect(save).toBeGreaterThan(restartCheck);
    expect(script.indexOf('write_meta "update_status" "success"')).toBeGreaterThan(save);
  });

  it('snapshots the database WAL-safely and puts it back on rollback', () => {
    // Rolling back restores code but never un-applies a migration, and this
    // repo's own history drops columns. Old code against a forward schema fails
    // every query touching the rebuilt table (spec 24 -> Migration Safety).
    const cycle = runDatabaseSnapshotCycle();

    expect(cycle.afterSnapshot).toBe('before');
    expect(cycle.afterMutation).toBe('0');
    expect(cycle.afterRestore).toBe('before');
    // The sidecars belong to the migrated database; replaying them onto the
    // restored file would corrupt it.
    expect(cycle.sidecarsRemoved).toBe(true);
  });

  it('restores the database only when the migration actually moved the schema', () => {
    // Most updates carry no new migration; restoring then would discard every
    // event the worker recorded during the update window for no benefit.
    const script = readFileSync(resolve('scripts/update.sh'), 'utf8');

    expect(script).toContain('MIGRATIONS_BEFORE="$(applied_migration_count)"');
    expect(script).toContain('if (( MIGRATIONS_AFTER > MIGRATIONS_BEFORE )); then');
    expect(script).toContain('if [[ "$SCHEMA_CHANGED" == "1" && -n "$DB_SNAPSHOT" ]]; then');
    // Snapshot before migrating, and quiesce the worker before touching the file.
    expect(script.indexOf('snapshot_database "$DB_SNAPSHOT"')).toBeLessThan(
      script.indexOf('corepack yarn db:migrate'),
    );
    expect(script.indexOf('pm2 stop "$APP_NAME"')).toBeLessThan(
      script.indexOf('restore_database "$DB_SNAPSHOT"'),
    );
  });

  it('checks the fetched helper requirement before resetting to a candidate commit', () => {
    const script = readFileSync(resolve('scripts/update.sh'), 'utf8');
    const candidateCheck = script.indexOf('require_feature_helper_version "$CANDIDATE_HELPER_VERSION"');
    const reset = script.indexOf('git reset --hard "origin/$BRANCH"');
    expect(candidateCheck).toBeGreaterThan(-1);
    expect(reset).toBeGreaterThan(candidateCheck);
  });
});
