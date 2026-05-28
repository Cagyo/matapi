# 03 — Digital Sensor Driver (GPIO)

## Dependencies
- 02-sensor-core.md (`SensorDriverPort` interface)
- 01-database.md (sensors table)
- ../error-handling.md (typed domain errors)

## Overview

Digital sensors (door contacts, water leak detectors) connected via GPIO pins. Worker connects to pigpiod daemon via socket — no root required.

## System Setup

```bash
sudo systemctl enable pigpiod
sudo systemctl start pigpiod
```

Worker uses `pigpio` npm package in socket mode.

## Config Schema

```typescript
// Stored in sensors.config JSON column
{
  "pin": 17,
  "activeLow": true,       // true = LOW means triggered
  "pull": "up"              // "up" | "down" | "none"
}
```

## Defaults (from defaults.yml)

```yaml
digital:
  debounce_ms: 10000
  severity: info
  pull: up
  active_low: true
```

## Behavior

- On init: configure pin with pull resistor, attach interrupt callback
- On state change: emit `SensorEvent` with `oldValue` and `newValue`
- Debounce at driver level using `debounceMs` from sensor config
- `getState()` returns current pin value (mapped through activeLow)
- `healthCheck()` verifies pin is readable via pigpiod socket

## Validations

- GPIO pin must be in valid range (0-27 for Pi). Encapsulated in a `GpioPin` value object whose constructor throws `InvalidGpioPinError` on out-of-range values.
- **Pin uniqueness enforced**: no two sensors can use the same GPIO pin. Validated in the `AddSensorUseCase` / `ImportConfigUseCase` (application layer) against `SensorRepositoryPort` — pin conflict raises `PinAlreadyInUseError(pin, ownerName)`.
- The bot handler maps `PinAlreadyInUseError` to a locale key (e.g. `en.config.pinTaken`) that renders: `"GPIO pin 17 is already used by sensor 'front_door'"`. No string concatenation in handlers (see ../error-handling.md → Interface boundary mapping).

## Error Handling

- pigpiod unreachable: adapter raises `DriverUnavailableError`; registry marks sensor offline, admin notified via `NotifierPort`.
- Pin read failure: log at adapter (warn), translate to `SensorReadError`, registry marks sensor offline.
