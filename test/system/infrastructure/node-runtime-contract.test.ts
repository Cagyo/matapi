import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);

describe('supported runtime contract', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const deps = readFileSync('config/system-deps.yml', 'utf8');
  const ecosystem = readFileSync('ecosystem.config.js', 'utf8');
  const installer = readFileSync('scripts/install.sh', 'utf8');

  it('pins Node 22 and the direct Google clients', () => {
    expect(pkg.engines.node).toBe('22.x');
    expect(pkg.dependencies).toHaveProperty('@googleapis/drive');
    expect(pkg.dependencies).toHaveProperty('google-auth-library');
    expect(deps).toMatch(/^node: "22"$/m);
  });

  it('allows bounded upload cancellation before PM2 kills the process', () => {
    expect(ecosystem).toContain('kill_timeout: 10000');
    expect(ecosystem).toContain('max_memory_restart:');
  });

  it('provisions immutable installation archive state for the worker group', () => {
    expect(installer).toContain('local ARCHIVE_STATE_DIR="/etc/home-worker"');
    expect(installer).toContain('local ARCHIVE_KEY_PATH="$ARCHIVE_STATE_DIR/archive.key"');
    expect(installer).toContain('local INSTALLATION_ID_PATH="$ARCHIVE_STATE_DIR/installation-id"');
    expect(installer).toContain('install -d -m 0750 -o root -g "$USER" "$ARCHIVE_STATE_DIR"');
    expect(installer).toContain('if [ ! -e "$ARCHIVE_KEY_PATH" ] && [ ! -L "$ARCHIVE_KEY_PATH" ]; then');
    expect(installer).toContain('if [ ! -e "$INSTALLATION_ID_PATH" ] && [ ! -L "$INSTALLATION_ID_PATH" ]; then');
    expect(installer).toContain('sudo ln "$root_temporary" "$target"');
    expect(installer).toContain("metadata.st_nlink != 1");
    expect(installer).toContain("stream.write(os.urandom(32))");
    expect(installer).toContain("metadata.st_uid != expected_uid");
    expect(installer).toContain("metadata.st_gid != expected_gid");
  });

  it('creates valid archive state once and rejects malformed replacements', async () => {
    const stateDir = await mkdtemp(resolve(tmpdir(), 'home-worker-archive-state-'));
    const script = resolve('scripts/install.sh');
    const program = String.raw`
set -euo pipefail
sudo() {
  if [ "$1" = install ]; then
    if [ "$2" = -d ]; then
      command install -d -m "$4" -g "$8" "$9"
    else
      command install -m "$3" -g "$7" "$8" "$9"
    fi
    return
  fi
  if [ "$1" = chown ]; then return; fi
  command "$@"
}
source ${JSON.stringify(script)}
provision_archive_installation_state
cp "$HOME_WORKER_ARCHIVE_STATE_DIR/archive.key" "$HOME_WORKER_ARCHIVE_STATE_DIR/archive.key.before"
cp "$HOME_WORKER_ARCHIVE_STATE_DIR/installation-id" "$HOME_WORKER_ARCHIVE_STATE_DIR/installation-id.before"
[ "$(wc -c < "$HOME_WORKER_ARCHIVE_STATE_DIR/archive.key" | tr -d ' ' )" = 32 ]
provision_archive_installation_state
cmp -s "$HOME_WORKER_ARCHIVE_STATE_DIR/archive.key.before" "$HOME_WORKER_ARCHIVE_STATE_DIR/archive.key"
cmp -s "$HOME_WORKER_ARCHIVE_STATE_DIR/installation-id.before" "$HOME_WORKER_ARCHIVE_STATE_DIR/installation-id"
chmod 0600 "$HOME_WORKER_ARCHIVE_STATE_DIR/archive.key"
if provision_archive_installation_state; then exit 41; fi
chmod 0640 "$HOME_WORKER_ARCHIVE_STATE_DIR/archive.key"
rm "$HOME_WORKER_ARCHIVE_STATE_DIR/archive.key"
ln -s /dev/null "$HOME_WORKER_ARCHIVE_STATE_DIR/archive.key"
if provision_archive_installation_state; then exit 44; fi
rm "$HOME_WORKER_ARCHIVE_STATE_DIR/archive.key"
mv "$HOME_WORKER_ARCHIVE_STATE_DIR/archive.key.before" "$HOME_WORKER_ARCHIVE_STATE_DIR/archive.key"
printf 'not-a-uuid\n' > "$HOME_WORKER_ARCHIVE_STATE_DIR/installation-id"
if provision_archive_installation_state; then exit 42; fi
rm "$HOME_WORKER_ARCHIVE_STATE_DIR/installation-id"
ln -s /dev/null "$HOME_WORKER_ARCHIVE_STATE_DIR/installation-id"
if provision_archive_installation_state; then exit 43; fi
`;

    try {
      await expect(run('bash', ['-c', program], {
        env: {
          ...process.env,
          HOME_WORKER_INSTALL_LIBRARY: '1',
          HOME_WORKER_ARCHIVE_STATE_DIR: stateDir,
          HOME_WORKER_USER: String(process.getgid?.() ?? 0),
        },
      })).resolves.toMatchObject({ stdout: '' });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
