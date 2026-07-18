import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import type { UpdateCheck } from "../domain/ota-contracts";
import type { OtaFailureCode } from "../domain/ota-failure";
import {
  OTA_ADMIN_NOTIFICATIONS,
  type OtaAdminNotificationPort,
} from "../domain/ports/ota-admin-notification.port";
import { CheckForUpdatesUseCase } from "./check-for-updates.use-case";
import {
  UPDATE_DISCOVERY_CLOCK,
  type UpdateDiscoveryClockPort,
} from "./ports/update-discovery-clock.port";
import {
  UPDATE_DISCOVERY_OPTIONS,
  type UpdateDiscoveryOptions,
} from "./ports/update-discovery-options.port";
import {
  UPDATE_DISCOVERY_RANDOM,
  type UpdateDiscoveryRandomPort,
} from "./ports/update-discovery-random.port";
import {
  UPDATE_DISCOVERY_TIMER,
  type UpdateDiscoveryTimerHandle,
  type UpdateDiscoveryTimerPort,
} from "./ports/update-discovery-timer.port";

const ROUTINE_NETWORK_FAILURES: ReadonlySet<OtaFailureCode> = new Set([
  "network-unavailable",
  "network-timeout",
  "http-status",
]);

function assertOptions(options: UpdateDiscoveryOptions): void {
  if (
    !Number.isSafeInteger(options.pollIntervalMs) ||
    options.pollIntervalMs <= 0
  )
    throw new Error("invalid update discovery poll interval");
  if (
    !Number.isSafeInteger(options.startupJitterMaxMs) ||
    options.startupJitterMaxMs < 0 ||
    options.startupJitterMaxMs > 300_000
  ) {
    throw new Error("invalid update discovery startup jitter");
  }
}

@Injectable()
export class UpdateDiscoveryService implements OnModuleInit, OnModuleDestroy {
  private startupTimer: UpdateDiscoveryTimerHandle | null = null;
  private intervalTimer: UpdateDiscoveryTimerHandle | null = null;
  private inFlight: Promise<void> | null = null;
  private readonly volatileAcknowledgements = new Set<string>();

  constructor(
    private readonly check: CheckForUpdatesUseCase,
    @Inject(OTA_ADMIN_NOTIFICATIONS)
    private readonly notifications: OtaAdminNotificationPort,
    @Inject(UPDATE_DISCOVERY_CLOCK)
    private readonly clock: UpdateDiscoveryClockPort,
    @Inject(UPDATE_DISCOVERY_TIMER)
    private readonly timer: UpdateDiscoveryTimerPort,
    @Inject(UPDATE_DISCOVERY_RANDOM)
    private readonly random: UpdateDiscoveryRandomPort,
    @Inject(UPDATE_DISCOVERY_OPTIONS)
    private readonly options: UpdateDiscoveryOptions,
  ) {
    assertOptions(options);
  }

  onModuleInit(): void {
    const sample = this.random.next();
    if (!Number.isFinite(sample) || sample < 0 || sample > 1)
      throw new Error("invalid update discovery random sample");
    const jitter = Math.floor(sample * (this.options.startupJitterMaxMs + 1));
    this.startupTimer = this.timer.setTimeout(
      () => {
        this.startupTimer = null;
        this.intervalTimer = this.timer.setInterval(
          () => void this.checkNow().catch(() => undefined),
          this.options.pollIntervalMs,
        );
        void this.checkNow().catch(() => undefined);
      },
      Math.min(jitter, this.options.startupJitterMaxMs),
    );
  }

  onModuleDestroy(): void {
    if (this.startupTimer !== null) this.timer.clearTimeout(this.startupTimer);
    if (this.intervalTimer !== null)
      this.timer.clearInterval(this.intervalTimer);
    this.startupTimer = null;
    this.intervalTimer = null;
  }

  checkNow(): Promise<void> {
    if (this.inFlight !== null) return this.inFlight;
    const flight = this.runCheck();
    this.inFlight = flight;
    void flight.then(
      () => {
        if (this.inFlight === flight) this.inFlight = null;
      },
      () => {
        if (this.inFlight === flight) this.inFlight = null;
      },
    );
    return flight;
  }

  private async runCheck(): Promise<void> {
    const result = await this.check.execute();
    const now = this.clock.now();
    if (result.kind === "available") {
      await this.notifyAvailable(result.available, now);
      return;
    }
    if (
      result.kind === "failure" &&
      !ROUTINE_NETWORK_FAILURES.has(result.failure.code)
    ) {
      await this.notifyFailure(result, now);
    }
  }

  private async notifyAvailable(
    release: Extract<UpdateCheck, { kind: "available" }>["available"],
    now: Date,
  ): Promise<void> {
    const key = `release:${release.artifact.version}:${release.artifact.sha256}`;
    if (this.volatileAcknowledgements.has(key)) return;
    if (!(await this.check.isAvailableNotificationDue(release))) return;
    const outcome = await this.notifications.deliver({
      kind: "release-available",
      version: release.artifact.version,
      targetName: release.artifact.targetName,
      commit: release.artifact.commit,
    });
    if (outcome.delivered <= 0) return;
    this.volatileAcknowledgements.add(key);
    await this.check.acknowledgeAvailableNotification(release, now);
    this.volatileAcknowledgements.delete(key);
  }

  private async notifyFailure(
    result: Extract<UpdateCheck, { kind: "failure" }>,
    now: Date,
  ): Promise<void> {
    const key = `failure:${now.toISOString().slice(0, 10)}:${result.failure.code}`;
    if (this.volatileAcknowledgements.has(key)) return;
    let due: boolean;
    try {
      due = await this.check.isFailureNotificationDue(result.failure.code, now);
    } catch {
      due = true;
    }
    if (!due) return;
    const outcome = await this.notifications.deliver({
      kind: "discovery-failure",
      code: result.failure.code,
    });
    if (outcome.delivered <= 0) return;
    this.volatileAcknowledgements.add(key);
    await this.check.acknowledgeFailureNotification(result.failure.code, now);
    this.volatileAcknowledgements.delete(key);
  }
}
