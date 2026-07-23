import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const project = resolve(__dirname, '../../..');

describe('feature installer boundary', () => {
  it('uses a non-blocking root lock, fixed routine argv, and durable marker barrier', async () => {
    const helper = await readFile(resolve(project, 'scripts/feature-installer.py'), 'utf8');
    expect(helper).toContain("fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)");
    expect(helper).toContain("subprocess.Popen([ROUTINES_PATH, feature]");
    expect(helper).toContain("shell=False");
    expect(helper).toContain("write_atomic(result_fd, result_name, payload, worker_gid)");
    expect(helper).toContain("write_atomic(result_fd, result_name, payload, worker_gid)\n        remove_entry(claim_fd, name)\n        remove_entry(result_fd, request['jobId'] + '.running')");
  });

  it('installs only the exact feature-management units without broad filesystem restrictions', async () => {
    const unit = await readFile(resolve(project, 'systemd/homeworker-feature-install.service'), 'utf8');
    expect(unit).toContain('ExecStart=/usr/lib/home-worker/feature-installer');
    expect(unit).toContain('TimeoutStartSec=35min');
    expect(unit).not.toMatch(/ProtectSystem|ReadOnlyPaths|InaccessiblePaths|SystemCallFilter/u);
    await expect(readFile(resolve(project, 'systemd/homeworker-feature-supervisor-restart.service'), 'utf8'))
      .resolves.toContain('ExecStart=/bin/systemctl restart pm2-homeworker.service');
    await expect(readFile(resolve(project, 'systemd/homeworker-feature-host-reboot.service'), 'utf8'))
      .resolves.toContain('ExecStart=/bin/systemctl reboot');
  });
});
