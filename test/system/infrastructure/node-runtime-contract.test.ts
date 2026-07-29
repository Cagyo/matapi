import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

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
    expect(installer).toContain('ARCHIVE_KEY_PATH="/etc/home-worker/archive.key"');
    expect(installer).toContain('INSTALLATION_ID_PATH="/etc/home-worker/installation-id"');
    expect(installer).toContain('install -d -m 0750 -o root -g "$USER" "$ARCHIVE_STATE_DIR"');
    expect(installer).toMatch(/if \[ ! -f "\$ARCHIVE_KEY_PATH" \]/);
    expect(installer).toMatch(/if \[ ! -f "\$INSTALLATION_ID_PATH" \]/);
    expect(installer).toContain('install -m 640 -o root -g "$USER"');
  });
});
