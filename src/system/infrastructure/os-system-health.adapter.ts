import { Injectable, Logger } from '@nestjs/common';
import { exec } from 'node:child_process';
import { promises as fs, statSync } from 'node:fs';
import { totalmem } from 'node:os';
import { promisify } from 'node:util';
import {
  SystemHealthPort,
  SystemHealthSnapshot,
} from '../domain/ports/system-health.port';

const execAsync = promisify(exec);

/**
 * Production `SystemHealthPort` for Raspberry Pi / Linux hosts (spec 08).
 *
 * Each metric is gathered independently — a failure to read CPU temp or
 * `df` never breaks the snapshot. Unavailable fields return `null` so the
 * bot can render "N/A".
 */
@Injectable()
export class OsSystemHealthAdapter implements SystemHealthPort {
  private readonly logger = new Logger(OsSystemHealthAdapter.name);

  async collect(): Promise<SystemHealthSnapshot> {
    const [disk, cpuTempC, dbSizeBytes] = await Promise.all([
      this.readDisk(),
      this.readCpuTemp(),
      this.readDbSize(),
    ]);

    return {
      diskUsedBytes: disk.usedBytes,
      diskTotalBytes: disk.totalBytes,
      cpuTempC,
      memoryUsedBytes: process.memoryUsage().rss,
      memoryTotalBytes: totalmem(),
      uptimeSec: Math.round(process.uptime()),
      dbSizeBytes,
    };
  }

  private async readDisk(): Promise<{ usedBytes: number | null; totalBytes: number | null }> {
    try {
      // `df -kP /` is POSIX-portable; `-P` keeps output single-line.
      const { stdout } = await execAsync('df -kP /', { timeout: 5000 });
      const lines = stdout.trim().split('\n');
      const fields = lines[lines.length - 1]?.split(/\s+/);
      if (!fields || fields.length < 4) return { usedBytes: null, totalBytes: null };
      const totalKb = Number(fields[1]);
      const usedKb = Number(fields[2]);
      if (!Number.isFinite(totalKb) || !Number.isFinite(usedKb)) {
        return { usedBytes: null, totalBytes: null };
      }
      return { totalBytes: totalKb * 1024, usedBytes: usedKb * 1024 };
    } catch (err) {
      this.logger.warn(`df failed: ${(err as Error).message}`);
      return { usedBytes: null, totalBytes: null };
    }
  }

  private async readCpuTemp(): Promise<number | null> {
    try {
      const raw = await fs.readFile('/sys/class/thermal/thermal_zone0/temp', 'utf8');
      const milliC = Number(raw.trim());
      if (!Number.isFinite(milliC)) return null;
      return milliC / 1000;
    } catch {
      // Many platforms (macOS dev box) don't expose this file. That's fine.
      return null;
    }
  }

  private async readDbSize(): Promise<number | null> {
    const path = process.env.DATABASE_PATH || './data/dev.db';
    try {
      return statSync(path).size;
    } catch (err) {
      this.logger.warn(`db stat failed: ${(err as Error).message}`);
      return null;
    }
  }
}
