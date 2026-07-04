# 03 — Digital Sensor Driver (GPIO), Step Types & Manual Inversion

## Dependencies
- 02-sensor-core.md (`SensorDriverPort` interface)
- 01-database.md (sensors table)
- ../error-handling.md (typed domain errors)

## Overview

Digital sensors (door contacts, water leak detectors, PIR motion, mains power relays) connected via GPIO pins. The worker connects to the `pigpiod` daemon via socket — no root required. 

To provide semantic meaning without violating hexagonal layering, digital sensors expose a canonical `stepType` (device class) and a manual inversion switcher (`invert`). Both are fully manageable via Telegram `/config modify` and YAML import/export. The driver adapter auto-infers debouncing and resilience behavior from `stepType`, while the UI/Telegram layer maps boolean states to localized strings.

## System Setup

```bash
sudo systemctl enable pigpiod
sudo systemctl start pigpiod
```

Worker uses `pigpio` npm package in socket mode.

## Config Schema (`sensors.config` JSON column)

```typescript
{
  "pin": 17,
  "invert": true,          // Manual inversion switcher: true = LOW is triggered/active (aliases activeLow, default: true)
  "pull": "up",            // "up" | "down" | "none" (default: "up")
  "stepType": "leak_hazard" // "contact" | "leak_hazard" | "alarm" | "power" | "motion" | "button" (default: "contact")
}
```

### Manual Inversion Switcher (`invert` via Telegram & YAML)
To easily sync physical sensor state with reality without debugging GPIO electrical voltage levels, the config schema provides an `invert: boolean` toggle (which maps directly to / aliases `activeLow`). 
- **In Telegram:** If a door is physically open but reports as "Closed" in `/status`, admins can open `/config modify ➔ [Sensor] ➔ Invert State`. The bot instantly flips `invert: !current`, saves to SQLite, and replies: *"✅ Inverted logical state for 'front_door'. State is now: OPENED"*.
- **In YAML:** Editable via `invert: true|false` in `/import_config` and `/export_config`.

## Canonical Step Types & Auto-Inferred Rules

The driver adapter automatically infers debouncing strategy, timings, and default severity from `stepType`:

| Step Type (`stepType`) | Normal (`false`) | Triggered (`true`) | Auto-Inferred Debounce Strategy | Default Timings (Rise / Fall) | Default Severity | Primary Behavior |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`contact`** | `"Closed"` | `"Opened"` | **Symmetric** | 10,000 ms / 10,000 ms | `warning` | Perimeter entry monitoring; open-window checks. |
| **`leak_hazard`**| `"Dry"` | `"Leak Detected"`| **Asymmetric Alarm** | **50 ms** / 60,000 ms | `critical` | Flood probes. Bypasses Telegram mute/sleep windows. |
| **`alarm`** | `"Normal"` | `"Alarm"` | **Asymmetric Alarm** | **50 ms** / 60,000 ms | `critical` | Smoke, CO, gas, flame, or enclosure tamper switches. |
| **`power`** | `"Grid OK"` | `"Outage"` | **Symmetric** | 5,000 ms / 5,000 ms | `warning` | Mains AC monitoring; UPS/battery low-voltage alerts. |
| **`motion`** | `"Clear"` | `"Motion"` | **Asymmetric Cooldown**| **0 ms** / 5,000 ms | `info` | Auto-triggers camera snapshot/clip recording. |
| **`button`** | `"Released"` | `"Pressed"` | **Asymmetric Cooldown**| **0 ms** / 3,000 ms | `info` | Doorbells or panic switches (immediate action). |

## Hardware Resilience & Circuit Breaker

### 1. Asymmetric Alarm Debouncing
For `leak_hazard` and `alarm`, symmetric debouncing is prohibited to prevent oscillating/bubbling water from swallowing alarms. The driver verifies rising edges in **50ms** (to reject RF spikes) and latches the alarm in software for **60 continuous seconds** of clean `false` signal before declaring the hazard resolved.

### 2. Circuit Breaker with Polled Sampling Mode Fallback (Anti-Flapping)
To prevent loose wires or EMI from starving Node.js CPU without blinding the system to real emergencies:
- If a pin fires **>30 transitions within 60 seconds**, the adapter flags runtime status as `FAULTY_FLAPPING`.
- The adapter **detaches the `pigpiod` socket interrupt** and switches to **10-second Polled Sampling Mode** via `gpio.read()`.
- If a real flood or break-in holds the line steady for 10 seconds during polling, the alarm is still reported!
- An admin notification is emitted: *"⚠️ Sensor '{name}' (GPIO {pin}) switched to polled sampling due to signal flapping!"*
- If polling also flaps or fails, exponential backoff applies ($5\text{m} \rightarrow 15\text{m} \rightarrow 1\text{h}$).

### 3. Timer Lifecycle Cleanup (`destroy()`)
To prevent memory leaks and ghost event emissions in PM2 long-running workers, `DigitalGpioAdapter` maintains a strict timer registry (`private activeTimers = new Set<NodeJS.Timeout>()`). Every asymmetric latch, cooldown, or polling timer is registered, and `destroy()` unconditionally executes `clearTimeout`/`clearInterval` across the set before disposing the adapter.

## i18n & Presentation Contract (`src/locales/en.ts`)

### 1. i18n Dictionary (3-State Rule)
```typescript
export const en = {
  sensors: {
    steps: {
      contact:     { false: 'Closed',   true: 'Opened',        offline: '❓ Offline' },
      leak_hazard: { false: 'Dry',      true: 'Leak Detected', offline: '❓ Offline' },
      alarm:       { false: 'Normal',   true: 'Alarm',         offline: '❓ Offline' },
      power:       { false: 'Grid OK',  true: 'Outage',        offline: '❓ Offline' },
      motion:      { false: 'Clear',    true: 'Motion',        offline: '❓ Offline' },
      button:      { false: 'Released', true: 'Pressed',       offline: '❓ Offline' },
    },
    notifications: {
      alarmTriggered: '🚨 *CRITICAL ALARM:* {name} is now *{state}*!',
      alarmResolved:  '✅ *RESOLVED:* {name} is back to *{state}*.',
      infoChange:     'ℹ️ *{name}:* {state} (was {oldState})',
      flappingFault:  '⚠️ *FAULT:* Sensor *{name}* switched to polled sampling due to flapping!',
    }
  }
};
```

### 2. Directional & Boot-Time Alert Formatting
When formatting notifications, the presentation layer checks transition direction and boot-time rules:
- **Boot-Time & Critical Triggered (`newValue === true` on hazards):** Any time a critical hazard (`leak_hazard`, `alarm`) reports `true`, it **always** uses the `alarmTriggered` template with 🚨, regardless of whether `oldValue` was `false`, `offline`, or `undefined` (boot-time reading).
- **Critical Resolved (`true` ➔ `false`):** Uses `alarmResolved` template with ✅.
- **Routine / Info:** Uses `infoChange` template with ℹ️.

## Validations
- GPIO pin must be in valid range (0-27 for Pi). Encapsulated in `GpioPin` value object.
- **Pin uniqueness enforced**: no two sensors can use the same GPIO pin.
- `stepType` must be one of the 6 canonical strings.
- `invert` must be a boolean (aliases `activeLow`).

## Error Handling
- pigpiod unreachable: adapter raises `DriverUnavailableError`.
- Pin read failure: log at adapter (warn), translate to `SensorReadError`, mark offline.
- Flapping signal: circuit breaker trips, interrupt detached, switches to 10s polled sampling mode.
