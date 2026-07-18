import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import {
  NOTIFIER,
  type NotifierPort,
} from "../../events/domain/ports/notifier.port";
import { en } from "../../locales/en";
import type { UpdateCheck } from "../domain/ota-contracts";
import type { OtaFailureCode } from "../domain/ota-failure";
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
  private readonly volatileFailureClaims = new Set<string>();

  constructor(
    private readonly check: CheckForUpdatesUseCase,
    @Inject(NOTIFIER) private readonly notifier: NotifierPort,
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
    if (!this.notifier.isReady()) return;
    const now = this.clock.now();
    if (result.kind === "available") {
      if (await this.check.claimAvailableNotification(result.available, now)) {
        await this.notifier.notify({
          text: en.ota.releaseAvailable(
            result.available.artifact.version,
            result.available.artifact.commit.slice(0, 7),
          ),
          asFile: false,
        });
      }
      return;
    }
    if (
      result.kind === "failure" &&
      !ROUTINE_NETWORK_FAILURES.has(result.failure.code)
    ) {
      await this.notifyFailure(result, now);
    }
  }

  private async notifyFailure(
    result: Extract<UpdateCheck, { kind: "failure" }>,
    now: Date,
  ): Promise<void> {
    let claimed: boolean;
    try {
      claimed = await this.check.claimFailureNotification(
        result.failure.code,
        now,
      );
    } catch {
      const key = `${now.toISOString().slice(0, 10)}:${result.failure.code}`;
      claimed = !this.volatileFailureClaims.has(key);
      this.volatileFailureClaims.add(key);
    }
    if (claimed) {
      await this.notifier.notify({
        text: en.ota.discoveryFailure(result.failure.code),
        asFile: false,
      });
    }
  }
}
