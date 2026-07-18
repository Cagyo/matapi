import { Module } from "@nestjs/common";
import { EventModule } from "../events/event.module";
import { BootRecoveryService } from "./application/boot-recovery.service";
import { CheckForUpdatesUseCase } from "./application/check-for-updates.use-case";
import { GracefulShutdownService } from "./application/graceful-shutdown.service";
import { OtaAdminNotificationService } from "./application/ota-admin-notification.service";
import { UPDATE_CHECK_OPTIONS } from "./application/ports/update-check-options.port";
import {
  UPDATE_DISCOVERY_CLOCK,
  type UpdateDiscoveryClockPort,
} from "./application/ports/update-discovery-clock.port";
import { UPDATE_DISCOVERY_OPTIONS } from "./application/ports/update-discovery-options.port";
import {
  UPDATE_DISCOVERY_RANDOM,
  type UpdateDiscoveryRandomPort,
} from "./application/ports/update-discovery-random.port";
import {
  UPDATE_DISCOVERY_TIMER,
  type UpdateDiscoveryTimerPort,
} from "./application/ports/update-discovery-timer.port";
import { UPDATE_MANIFEST_POLICY } from "./application/ports/update-manifest-policy.port";
import { UpdateDiscoveryService } from "./application/update-discovery.service";
import { CLOCK_SYNC_PROBE } from "./domain/ports/clock-sync.port";
import { INSTALLED_RELEASE } from "./domain/ports/installed-release.port";
import { OTA_ADMIN_NOTIFICATIONS } from "./domain/ports/ota-admin-notification.port";
import { OTA_CLOCK } from "./domain/ports/ota-clock.port";
import { OTA_OPERATION_LAUNCHER } from "./domain/ports/ota-operation-launcher.port";
import { OTA } from "./domain/ports/ota.port";
import { PROCESS_RESTARTER } from "./domain/ports/process-restarter.port";
import { RELEASE_FEED_TRANSPORT } from "./domain/ports/release-feed-transport.port";
import { SIGNED_ENVELOPE_VERIFIER } from "./domain/ports/signed-envelope-verifier.port";
import { SYSTEM_DEPS } from "./domain/ports/system-deps.port";
import { SYSTEM_META_REPOSITORY } from "./domain/ports/system-meta-repository.port";
import { SYSTEM_HEALTH } from "./domain/ports/system-health.port";
import { TRUSTED_STATE } from "./domain/ports/trusted-state.port";
import { DrizzleSystemMetaRepository } from "./infrastructure/drizzle-system-meta.repository";
import { DualSlotTrustedStateAdapter } from "./infrastructure/dual-slot-trusted-state.adapter";
import { Ed25519EnvelopeVerifierAdapter } from "./infrastructure/ed25519-envelope-verifier.adapter";
import { FsInstalledReleaseAdapter } from "./infrastructure/fs-installed-release.adapter";
import { NodeReleaseFeedTransportAdapter } from "./infrastructure/node-release-feed-transport.adapter";
import { loadOtaConfig } from "./infrastructure/ota-discovery-config.loader";
import { otaOperationLauncherForMode } from "./infrastructure/ota-operation-launcher.factory";
import { OsSystemHealthAdapter } from "./infrastructure/os-system-health.adapter";
import { Pm2ProcessRestarter } from "./infrastructure/pm2-process-restarter.adapter";
import { ProcOtaClockAdapter } from "./infrastructure/proc-ota-clock.adapter";
import { ShellOtaAdapter } from "./infrastructure/shell-ota.adapter";
import { ShellSystemDepsAdapter } from "./infrastructure/shell-system-deps.adapter";
import { TimedatectlClockSyncAdapter } from "./infrastructure/timedatectl-clock-sync.adapter";
import { StubOtaAdapter } from "./infrastructure/stub-ota.adapter";
import { StubProcessRestarter } from "./infrastructure/stub-process-restarter.adapter";
import { StubSystemDepsAdapter } from "./infrastructure/stub-system-deps.adapter";

export type SystemMode = "real" | "stub";

export function resolveSystemMode(): SystemMode {
  if (process.env.SYSTEM_MODE === "stub") return "stub";
  if (process.env.SYSTEM_MODE === "real") return "real";
  if (process.env.NODE_ENV === "test" || process.env.NODE_ENV === "development")
    return "stub";
  return process.platform === "linux" ? "real" : "stub";
}

const mode = resolveSystemMode();
const runtimeLibcVersion = (() => {
  if (mode === "stub") return "2.28";
  const report = process.report.getReport() as {
    header?: { glibcVersionRuntime?: unknown };
  };
  const value = report.header?.glibcVersionRuntime;
  if (typeof value !== "string") {
    throw new Error("runtime glibc version report is unavailable");
  }
  return value;
})();
const otaConfig = loadOtaConfig({
  mode,
  env: process.env,
  platform: process.platform,
  architecture: process.arch,
  nodeModulesAbi: process.versions.modules,
  runtimeLibcVersion,
  nodeExecutable: process.execPath,
});

const timer: UpdateDiscoveryTimerPort = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (handle) =>
    clearInterval(handle as ReturnType<typeof setInterval>),
};

/**
 * Cross-cutting `system/` context — exposes OS-level metrics, OTA control,
 * process-restart capability, and boot/shutdown coordination (spec 23) to
 * other contexts via ports. Imports `EventModule` so the shutdown coordinator
 * can drain the event pipeline and broadcast the offline notice.
 */
@Module({
  imports: [EventModule],
  providers: [
    BootRecoveryService,
    CheckForUpdatesUseCase,
    GracefulShutdownService,
    OtaAdminNotificationService,
    UpdateDiscoveryService,
    {
      provide: OTA_ADMIN_NOTIFICATIONS,
      useExisting: OtaAdminNotificationService,
    },
    { provide: SYSTEM_HEALTH, useClass: OsSystemHealthAdapter },
    { provide: SYSTEM_META_REPOSITORY, useClass: DrizzleSystemMetaRepository },
    {
      provide: PROCESS_RESTARTER,
      useClass: mode === "stub" ? StubProcessRestarter : Pm2ProcessRestarter,
    },
    {
      provide: OTA,
      useClass: mode === "stub" ? StubOtaAdapter : ShellOtaAdapter,
    },
    {
      provide: OTA_OPERATION_LAUNCHER,
      useValue: otaOperationLauncherForMode(mode, otaConfig),
    },
    {
      provide: SYSTEM_DEPS,
      useClass:
        mode === "stub" ? StubSystemDepsAdapter : ShellSystemDepsAdapter,
    },
    { provide: CLOCK_SYNC_PROBE, useClass: TimedatectlClockSyncAdapter },
    {
      provide: RELEASE_FEED_TRANSPORT,
      useClass: NodeReleaseFeedTransportAdapter,
    },
    {
      provide: TRUSTED_STATE,
      useFactory: () =>
        new DualSlotTrustedStateAdapter(
          process.env.HOME_WORKER_UPDATE_STATE_DIR ??
            "/opt/home-worker/shared/update",
        ),
    },
    {
      provide: OTA_CLOCK,
      useFactory: (clockSync: TimedatectlClockSyncAdapter) =>
        new ProcOtaClockAdapter(clockSync),
      inject: [CLOCK_SYNC_PROBE],
    },
    {
      provide: INSTALLED_RELEASE,
      useFactory: () =>
        new FsInstalledReleaseAdapter(
          process.env.HOME_WORKER_ROOT ?? "/opt/home-worker",
        ),
    },
    {
      provide: SIGNED_ENVELOPE_VERIFIER,
      useFactory: () =>
        new Ed25519EnvelopeVerifierAdapter(otaConfig.trustDirectory),
    },
    {
      provide: UPDATE_MANIFEST_POLICY,
      useValue: otaConfig.policy,
    },
    {
      provide: UPDATE_CHECK_OPTIONS,
      useValue: otaConfig.checkOptions,
    },
    {
      provide: UPDATE_DISCOVERY_CLOCK,
      useValue: {
        now: (): Date => new Date(),
      } satisfies UpdateDiscoveryClockPort,
    },
    { provide: UPDATE_DISCOVERY_TIMER, useValue: timer },
    {
      provide: UPDATE_DISCOVERY_RANDOM,
      useValue: {
        next: (): number => Math.random(),
      } satisfies UpdateDiscoveryRandomPort,
    },
    {
      provide: UPDATE_DISCOVERY_OPTIONS,
      useValue: otaConfig.discoveryOptions,
    },
  ],
  exports: [
    SYSTEM_HEALTH,
    SYSTEM_META_REPOSITORY,
    PROCESS_RESTARTER,
    OTA,
    OTA_OPERATION_LAUNCHER,
    SYSTEM_DEPS,
    CLOCK_SYNC_PROBE,
    BootRecoveryService,
    GracefulShutdownService,
    CheckForUpdatesUseCase,
    OtaAdminNotificationService,
  ],
})
export class SystemModule {}
