# 04 — UART CO2 Sensor Driver

## Dependencies
- 02-sensor-core.md (ISensorDriver interface)
- 01-database.md (sensors table, sensor_logs table)

## Overview

CO2 sensor connected via UART serial port. Uses `serialport` npm package.

## Config Schema

```typescript
{
  "port": "/dev/serial0",
  "baudRate": 9600,
  "thresholds": {
    "warning": 800,
    "critical": 1200
  }
}
```

## Defaults (from .env)

```
CO2_READ_INTERVAL_MS=5000
CO2_FLUSH_INTERVAL_MS=60000
CO2_WARNING_PPM=800
CO2_CRITICAL_PPM=1200
```

## Behavior

- Read sensor every 5 seconds, store in memory buffer
- Flush buffered readings to `sensor_logs` every 60 seconds
- On threshold crossing (normal→warning, warning→critical, or reverse): emit `SensorEvent` immediately
- `getState()` returns current PPM value + level (normal/warning/critical)
- `healthCheck()` verifies serial port responds to a read command

## Data Validation

- Readings validated against sane range: 0-5000 ppm
- Outlier readings discarded (not stored)
- After N consecutive bad reads (e.g., 10): log warning, mark sensor as degraded

## `/status` Display

```
🌬️ co2_living: 620 ppm ✅
🌬️ co2_living: 950 ppm ⚠️
🌬️ co2_living: 1350 ppm 🚨
```

## Error Handling

- Port not found (ENOENT): mark offline, notify admin
- Port busy (EACCES): mark offline, notify admin
- Garbled data: discard, log warning
- Device unplugged mid-operation: catch error, mark offline, attempt reconnect on interval

## Memory Buffer & Crash Risk

CO2 buffer is in-memory only. If process crashes, up to 60 seconds of readings are lost. This is acceptable for CO2 data — it's non-critical continuous monitoring.
