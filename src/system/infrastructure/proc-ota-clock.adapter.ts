import { readFileSync } from "node:fs";
import type { ClockSyncProbePort } from "../domain/ports/clock-sync.port";
import type {
  OtaClockPort,
  OtaClockSnapshot,
} from "../domain/ports/ota-clock.port";

export interface ProcOtaClockSources {
  wallNow(): number;
  readMonotonicMs(): number;
  readBootId(): string;
}

const DEFAULT_SOURCES: ProcOtaClockSources = {
  wallNow: () => Date.now(),
  readMonotonicMs: () => {
    const uptimeSeconds = readFileSync("/proc/uptime", {
      encoding: "utf8",
    }).split(/\s+/, 1)[0];
    return Math.floor(Number(uptimeSeconds) * 1000);
  },
  readBootId: () =>
    readFileSync("/proc/sys/kernel/random/boot_id", { encoding: "utf8" }),
};

/** Linux OTA clock backed by the kernel boot ID and process monotonic time. */
export class ProcOtaClockAdapter implements OtaClockPort {
  constructor(
    private readonly clockSync: ClockSyncProbePort,
    private readonly sources: ProcOtaClockSources = DEFAULT_SOURCES,
  ) {}

  async capture(): Promise<OtaClockSnapshot> {
    const status = await this.clockSync.probe();
    const bootId = this.sources.readBootId().trim();
    if (bootId.length === 0) throw new Error("Linux boot ID is empty");
    return {
      synchronized: status.synchronized,
      wallMs: this.sources.wallNow(),
      monotonicMs: this.sources.readMonotonicMs(),
      bootId,
    };
  }
}
