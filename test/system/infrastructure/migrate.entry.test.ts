import Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  runRuntimeMigrations,
  type RuntimeMigrationDependencies,
} from "../../../src/system/infrastructure/migrate.entry";

describe("runtime migration entry", () => {
  it("uses the runtime database migration coordinator and always closes SQLite", () => {
    const sqlite = new Database(":memory:");
    const coordinator = vi.fn();
    const dependencies: RuntimeMigrationDependencies = {
      openDatabase: vi.fn(() => sqlite),
      migrateDatabase: coordinator,
    };

    runRuntimeMigrations(
      {
        databasePath: "/var/lib/home-worker/data.db",
        migrationsFolder: "/opt/home-worker/current/migrations",
      },
      dependencies,
    );

    expect(dependencies.openDatabase).toHaveBeenCalledWith(
      "/var/lib/home-worker/data.db",
    );
    expect(coordinator).toHaveBeenCalledWith(
      sqlite,
      "/opt/home-worker/current/migrations",
    );
    expect(sqlite.open).toBe(false);
  });

  it("keeps drizzle-kit out of the runtime migration command", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve("package.json"), "utf8"),
    ) as {
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    expect(packageJson.scripts["db:migrate"]).toBe(
      "node dist/system/infrastructure/migrate.entry.js",
    );
    expect(packageJson.dependencies).not.toHaveProperty("drizzle-kit");
    expect(packageJson.devDependencies).toHaveProperty("drizzle-kit");
  });

  it("configures the build to carry runtime migrations with both detached entries", () => {
    const nestCli = JSON.parse(
      readFileSync(resolve("nest-cli.json"), "utf8"),
    ) as {
      compilerOptions: { assets?: { include: string; outDir: string }[] };
    };
    const configSource = readFileSync(
      resolve("src/system/infrastructure/ota-discovery-config.loader.ts"),
      "utf8",
    );

    expect(nestCli.compilerOptions.assets).toContainEqual({
      include: "../migrations/**/*",
      outDir: "dist/migrations",
    });
    expect(configSource).toContain('"ota-updater.entry.js"');
    expect(
      existsSync(resolve("src/system/infrastructure/ota-updater.entry.ts")),
    ).toBe(true);
  });
});
