import type { LiveViewSettingsDocument } from "../live-view-settings";

export interface LiveViewSettingsStorePort {
  readCommitted(): Promise<LiveViewSettingsDocument>;
  bootLoadedGeneration(): number | null;
  simulateDevelopmentRestart(): Promise<void>;
}
