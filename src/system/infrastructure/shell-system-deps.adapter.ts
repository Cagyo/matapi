import { Injectable, Logger } from '@nestjs/common';
import { exec } from 'node:child_process';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { parse } from 'yaml';
import { SystemDepsCheckFailedError } from '../domain/errors/system-deps-check-failed.error';
import {
  DepUpdate,
  SystemDepsCheck,
  SystemDepsPort,
} from '../domain/ports/system-deps.port';

const execAsync = promisify(exec);

/**
 * apt packages eligible for `/system_update`. The set is the intersection of
 * the apt entries declared in `config/system-deps.yml` and this curated
 * allowlist — keeping the diff aligned with what `scripts/system-update.sh`
 * actually upgrades (spec 18 / spec 24). `rclone` and `node` are inspected
 * separately since they are not apt-managed in the same way.
 */
const UPGRADABLE_APT = ['motion', 'ffmpeg', 'mosquitto'] as const;

interface SystemDepsYaml {
  node?: string | number;
  [feature: string]: unknown;
}

/** Flatten `feature.apt[]` arrays and intersect with the allowlist. */
export function selectAptPackages(config: SystemDepsYaml): string[] {
  const declared = new Set<string>();
  for (const value of Object.values(config)) {
    if (value && typeof value === 'object' && 'apt' in value) {
      const apt = (value as { apt?: unknown }).apt;
      if (Array.isArray(apt)) {
        for (const pkg of apt) {
          if (typeof pkg === 'string') declared.add(pkg);
        }
      }
    }
  }
  return UPGRADABLE_APT.filter((pkg) => declared.has(pkg));
}

function matchPolicy(
  stdout: string,
  field: 'Installed' | 'Candidate',
): string | null {
  const match = new RegExp(`${field}:\\s*(\\S+)`).exec(stdout);
  return match ? match[1] : null;
}

/** Parse `apt-cache policy <name>` output into a diff entry. */
export function parseAptPolicy(name: string, stdout: string): DepUpdate {
  const installed = matchPolicy(stdout, 'Installed');
  const candidate = matchPolicy(stdout, 'Candidate');

  if (!installed || installed === '(none)') {
    return { name, current: null, available: candidate, kind: 'not-installed' };
  }
  if (candidate && candidate !== installed) {
    return { name, current: installed, available: candidate, kind: 'upgrade' };
  }
  return { name, current: installed, available: candidate, kind: 'none' };
}

/** Extract the installed rclone version from `rclone version` output. */
export function parseRcloneVersion(stdout: string): string | null {
  return (/rclone\s+v?(\S+)/.exec(stdout))?.[1] ?? null;
}

/** Build an rclone diff from the installed version + `selfupdate --check`. */
export function parseRcloneCheck(
  current: string | null,
  checkStdout: string,
): DepUpdate {
  const available = (/latest:\s*v?(\d[\w.+-]*)/i.exec(checkStdout))?.[1] ?? null;
  if (available && current && available !== current) {
    return { name: 'rclone', current, available, kind: 'upgrade' };
  }
  return { name: 'rclone', current, available: available ?? current, kind: 'none' };
}

/** Compare the installed node version against the desired major. */
export function evaluateNode(
  current: string,
  desiredMajor: string | null,
): DepUpdate {
  if (!desiredMajor) {
    return { name: 'node', current, available: current, kind: 'none' };
  }
  const currentMajor = current.split('.')[0];
  if (currentMajor !== desiredMajor) {
    return {
      name: 'node',
      current,
      available: `${desiredMajor}.x`,
      kind: 'node-major',
    };
  }
  // Same major: minor/patch bumps are handled by the apply script at
  // upgrade time; we don't query NodeSource here (spec 18 decision).
  return { name: 'node', current, available: current, kind: 'none' };
}

/**
 * Shell-backed `SystemDepsPort` for Raspberry Pi / Linux hosts (spec 18).
 *
 * `check()` never mutates the system and degrades gracefully: on hosts
 * without apt/rclone (e.g. macOS dev box) each dependency reports `unknown`
 * rather than throwing. `applyUpdate()` delegates the snapshot → apt →
 * rclone → node → health-check sequence to `scripts/system-update.sh`.
 */
@Injectable()
export class ShellSystemDepsAdapter implements SystemDepsPort {
  private readonly logger = new Logger(ShellSystemDepsAdapter.name);
  private readonly installDir =
    process.env.HOME_WORKER_INSTALL_DIR ?? process.cwd();
  private readonly depsFile = resolve(
    this.installDir,
    'config/system-deps.yml',
  );

  async check(): Promise<SystemDepsCheck> {
    const config = await this.readConfig();
    const aptPackages = selectAptPackages(config);

    // Best-effort metadata refresh; a failure here just means candidate
    // versions may be stale, not that the whole check fails. `-n` keeps
    // sudo non-interactive so a missing NOPASSWD rule fails fast instead
    // of blocking on a password prompt.
    await execAsync('sudo -n apt-get update -qq', { timeout: 60_000 }).catch(
      (err: Error) => {
        this.logger.warn(`apt-get update failed: ${err.message}`);
      },
    );

    const aptDeps = await Promise.all(
      aptPackages.map((name) => this.checkApt(name)),
    );
    const rclone = await this.checkRclone();
    const node = await this.checkNode(config);

    const deps: DepUpdate[] = [...aptDeps, rclone, node];
    const hasUpdates = deps.some(
      (d) => d.kind === 'upgrade' || d.kind === 'node-minor',
    );
    const nodeMajorMismatch = node.kind === 'node-major';

    return { deps, hasUpdates, nodeMajorMismatch };
  }

  async applyUpdate(): Promise<void> {
    const scriptPath = resolve(this.installDir, 'scripts/system-update.sh');
    this.logger.warn(`Spawning system-update script ${scriptPath}`);
    const child = spawn('/bin/bash', [scriptPath], {
      cwd: this.installDir,
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
  }

  private async readConfig(): Promise<SystemDepsYaml> {
    try {
      const text = await readFile(this.depsFile, 'utf8');
      return (parse(text) as SystemDepsYaml) ?? {};
    } catch (err) {
      throw new SystemDepsCheckFailedError(
        `cannot read system-deps.yml: ${(err as Error).message}`,
      );
    }
  }

  private async checkApt(name: string): Promise<DepUpdate> {
    try {
      const { stdout } = await execAsync(`apt-cache policy ${name}`, {
        timeout: 10_000,
      });
      return parseAptPolicy(name, stdout);
    } catch {
      // apt-cache absent (dev host) or package unknown.
      return { name, current: null, available: null, kind: 'unknown' };
    }
  }

  private async checkRclone(): Promise<DepUpdate> {
    let current: string | null = null;
    try {
      const { stdout } = await execAsync('rclone version', { timeout: 10_000 });
      current = parseRcloneVersion(stdout);
    } catch {
      return { name: 'rclone', current: null, available: null, kind: 'not-installed' };
    }

    try {
      const { stdout } = await execAsync('rclone selfupdate --check', {
        timeout: 15_000,
      });
      return parseRcloneCheck(current, stdout);
    } catch {
      // selfupdate --check unavailable; report installed version only.
      return { name: 'rclone', current, available: null, kind: 'unknown' };
    }
  }

  private async checkNode(config: SystemDepsYaml): Promise<DepUpdate> {
    const desiredMajor =
      config.node != null ? String(config.node).trim() : null;

    let current: string | null = null;
    try {
      const { stdout } = await execAsync('node -v', { timeout: 5_000 });
      current = stdout.trim().replace(/^v/, '');
    } catch {
      return { name: 'node', current: null, available: null, kind: 'unknown' };
    }

    return evaluateNode(current, desiredMajor);
  }
}
