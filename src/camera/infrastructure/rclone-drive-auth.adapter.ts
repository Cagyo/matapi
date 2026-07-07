import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { chmod, copyFile, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { GdriveAuthFailedError } from '../domain/errors/gdrive-auth-failed.error';
import { GdriveNotInstalledError } from '../domain/errors/gdrive-not-installed.error';
import { DriveAuthPort } from '../domain/ports/drive-auth.port';

const exec = promisify(execFile);

interface ExecError extends Error {
  stdout?: string;
  stderr?: string;
  code?: number | string;
}

/**
 * Production `DriveAuthPort` — manages `rclone.conf` [gdrive] section (spec 15).
 *
 * Resolves config path via `rclone config file`, creates backups, replaces or
 * appends the [gdrive] section, and restores backups on rollback.
 */
@Injectable()
export class RcloneDriveAuthAdapter implements DriveAuthPort {
  private readonly logger = new Logger(RcloneDriveAuthAdapter.name);

  async updateConfig(configSnippet: string): Promise<void> {
    const configPath = await this.resolveConfigPath();
    const backupPath = `${configPath}.bak`;

    let existingContent = '';
    try {
      existingContent = await readFile(configPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        const msg = (err as Error).message;
        this.logger.error(`Failed to read rclone.conf: ${msg}`, (err as Error).stack);
        throw new GdriveAuthFailedError(`cannot read config file: ${msg}`);
      }
    }

    try {
      await writeFile(backupPath, existingContent, { mode: 0o600 });
    } catch (err) {
      const msg = (err as Error).message;
      this.logger.error(`Failed to write config backup: ${msg}`, (err as Error).stack);
      throw new GdriveAuthFailedError(`cannot write config backup: ${msg}`);
    }

    const newContent = this.replaceGdriveSection(existingContent, configSnippet);

    try {
      await writeFile(configPath, newContent, { mode: 0o600 });
      await chmod(configPath, 0o600).catch(() => {});
    } catch (err) {
      const msg = (err as Error).message;
      this.logger.error(`Failed to write new rclone.conf: ${msg}`, (err as Error).stack);
      throw new GdriveAuthFailedError(`cannot write new config: ${msg}`);
    }
  }

  async restoreBackup(): Promise<void> {
    let configPath: string;
    try {
      configPath = await this.resolveConfigPath();
    } catch (err) {
      this.logger.error(`Failed to resolve config path during restore: ${(err as Error).message}`);
      return;
    }

    const backupPath = `${configPath}.bak`;
    try {
      await copyFile(backupPath, configPath);
      await chmod(configPath, 0o600).catch(() => {});
      this.logger.log(`Restored rclone.conf from ${backupPath}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.error(
          `Failed to restore backup from ${backupPath}: ${(err as Error).message}`,
          (err as Error).stack,
        );
        throw new GdriveAuthFailedError(`failed to restore backup: ${(err as Error).message}`);
      } else {
        this.logger.warn(`No backup file found at ${backupPath} to restore.`);
      }
    }
  }

  private async resolveConfigPath(): Promise<string> {
    let stdout: string;
    try {
      ({ stdout } = await exec('rclone', ['config', 'file'], {
        timeout: 15000,
      }));
    } catch (err) {
      const e = err as ExecError;
      const text = `${e.stderr ?? ''} ${e.message ?? ''}`.trim();
      this.logger.warn(`rclone config file failed: ${text}`);
      if (e.code === 'ENOENT' || /not found|command not found/i.test(text)) {
        throw new GdriveNotInstalledError();
      }
      throw new GdriveAuthFailedError(`failed to locate rclone config: ${text}`);
    }

    const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const path = lines.pop();
    if (!path) {
      throw new GdriveAuthFailedError('rclone config file returned empty output');
    }
    return path;
  }

  private replaceGdriveSection(content: string, snippet: string): string {
    const cleanSnippet = snippet.trim();
    const regex = /(?:^|\r?\n)\[gdrive\][ \t]*(?:\r?\n|$)(?:[\s\S]*?)(?=(?:\r?\n[ \t]*\[|$))/i;
    const match = regex.exec(content);
    if (!match) {
      if (!content.trim()) return cleanSnippet + '\n';
      return content.trimEnd() + '\n\n' + cleanSnippet + '\n';
    }
    const matchedText = match[0];
    const prefix = matchedText.startsWith('\r\n')
      ? '\r\n'
      : matchedText.startsWith('\n')
        ? '\n'
        : '';
    const replaced = content.replace(matchedText, prefix + cleanSnippet);
    return replaced.trimEnd() + '\n';
  }
}
