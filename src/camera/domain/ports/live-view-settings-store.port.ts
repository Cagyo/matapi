import type { LiveViewSettingsDocument } from "../live-view-settings";

export const LIVE_VIEW_SETTINGS_STORE = Symbol("LIVE_VIEW_SETTINGS_STORE");

export interface LiveViewSettingsStorePort {
  readCommitted(): Promise<LiveViewSettingsDocument>;
  bootLoadedGeneration(): number | null;
  simulateDevelopmentRestart(): Promise<void>;
}
