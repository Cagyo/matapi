import "reflect-metadata";
import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { resolve } from "node:path";
import { AppModule } from "./app.module";
import { PidLockGateway } from "./system/infrastructure/pid-lock.gateway";
import { ProcessShutdownGateway } from "./system/infrastructure/process-shutdown.gateway";
import { prepareApplicationShutdown } from "./prepare-application-shutdown";
import {
  ReadinessMarkerAdapter,
  readinessContextFromEnvironment,
} from "./system/infrastructure/readiness-marker.adapter";

const lock = new PidLockGateway(
  resolve(process.env.PID_LOCK_PATH || "./data/worker.pid"),
);

async function bootstrap(): Promise<void> {
  lock.acquire();

  const app = await NestFactory.create(AppModule, {
    logger: ["log", "warn", "error", "debug"],
  });
  const shutdown = new ProcessShutdownGateway({
    prepare: (signal) => prepareApplicationShutdown(app, signal),
    closeApplication: () => app.close(),
    releaseLock: () => lock.release(),
    setExitCode: (code) => {
      process.exitCode = code;
    },
  });

  process.on("SIGINT", () => void shutdown.run("SIGINT"));
  process.on("SIGTERM", () => void shutdown.run("SIGTERM"));

  const hookPort =
    Number(process.env.MOTION_HOOK_PORT || process.env.PORT) || 4000;
  // Bind to loopback only — the Motion daemon runs on the same host and the
  // hook routes must never be reachable off-box (spec 20).
  await app.listen(hookPort, "127.0.0.1");
  const readinessContext = readinessContextFromEnvironment(process.env);
  if (readinessContext !== null) {
    await new ReadinessMarkerAdapter().publish(readinessContext);
  }
  Logger.log(
    `Home Worker started (pid ${process.pid}), motion hooks on 127.0.0.1:${hookPort}`,
    "Bootstrap",
  );
}

bootstrap().catch((err: unknown) => {
  Logger.error(
    err instanceof Error ? (err.stack ?? err.message) : String(err),
    "Bootstrap",
  );
  lock.release();
  process.exit(1);
});
