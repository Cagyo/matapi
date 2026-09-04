export type LiveViewSettingsStateReason =
  | "invalid-settings-state"
  | "unsafe-settings-state"
  | "development-operation-unavailable";

export class LiveViewSettingsStateError extends Error {
  readonly code = "LIVE_VIEW_SETTINGS_STATE_INVALID" as const;

  constructor(
    readonly reason: LiveViewSettingsStateReason = "invalid-settings-state",
  ) {
    super("Live view settings state is invalid");
    this.name = "LiveViewSettingsStateError";
  }
}
