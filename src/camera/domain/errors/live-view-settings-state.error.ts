export class LiveViewSettingsStateError extends Error {
  readonly code = "LIVE_VIEW_SETTINGS_STATE_INVALID" as const;

  constructor() {
    super("Live view settings state is invalid");
    this.name = "LiveViewSettingsStateError";
  }
}
