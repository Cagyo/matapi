# Digital Sensor Default Debounce

## Goal

Make newly created digital sensors responsive to normal switch and contact
changes without altering the debounce stored for existing sensors.

## Design

- Change `sensor_defaults.digital.debounce_ms` in `config/defaults.yml` from
  `10000` to `100` milliseconds.
- Make the digital fallback in the Telegram configuration flow 100 ms.
- Make an imported digital sensor without `debounce_ms` resolve to 100 ms.
- Make persisted digital rows with a null `debounce_ms` read as 100 ms.
- Preserve the existing defaults for UART (0 ms), MQTT, and camera sensors.
- Leave the SQLite column default unchanged because it cannot be type-aware;
  normal creation and import paths always write an explicit debounce value.
- Update the digital-sensor specification to document the new 100 ms default.
- Do not migrate or modify existing `sensors.debounce_ms` database rows; their
  configured values remain authoritative.
- Keep `/config → Modify → Debounce` as the per-sensor override.

## Verification

- Add focused tests for the shipped YAML default, the Telegram fallback, the
  YAML import default, and a legacy null database value.
- Run the focused tests and the build.
