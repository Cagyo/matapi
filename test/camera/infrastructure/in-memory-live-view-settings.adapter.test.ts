import { describe, expect, it } from "vitest";

import { InMemoryLiveViewSettingsAdapter } from "../../../src/camera/infrastructure/in-memory-live-view-settings.adapter";

const settingsV3 = {
  version: 1 as const,
  generation: 3,
  enabled: false,
  allowedCameraCidrs: ["192.168.1.0/24"],
};

describe("InMemoryLiveViewSettingsAdapter", () => {
  it("promotes the committed generation only when a development restart is simulated", async () => {
    const store = new InMemoryLiveViewSettingsAdapter(settingsV3);
    const settingsV4 = { ...settingsV3, generation: 4, enabled: true };

    store.setCommitted(settingsV4);
    expect(await store.readCommitted()).toEqual(settingsV4);
    expect(store.bootLoadedGeneration()).toBe(3);
    await store.simulateDevelopmentRestart();
    expect(store.bootLoadedGeneration()).toBe(4);
  });

  it("validates and clones committed settings at the adapter boundary", async () => {
    const mutable = {
      version: 1 as const,
      generation: 3,
      enabled: false,
      allowedCameraCidrs: ["192.168.2.42/24"],
    };
    const store = new InMemoryLiveViewSettingsAdapter(mutable);
    mutable.allowedCameraCidrs.push("10.0.0.0/8");

    expect(await store.readCommitted()).toEqual({
      ...settingsV3,
      allowedCameraCidrs: ["192.168.2.0/24"],
    });
    expect(() =>
      store.setCommitted({ ...settingsV3, generation: -1 }),
    ).toThrow();
  });
});
