export class LiveViewSettingsBusyError extends Error {
  readonly code = "LIVE_VIEW_SETTINGS_BUSY" as const;

  constructor() {
    super("A live view settings mutation is already active");
    this.name = "LiveViewSettingsBusyError";
  }
}
