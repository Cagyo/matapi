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
- `healthCheck()` verifies serial port responds to a read command; it shares an in-flight command with a simultaneous poll rather than issuing a concurrent UART request

## UART Transport and Recovery

- The serial source is event-driven: incoming `data` chunks are accumulated until a complete MH-Z19 frame can be aligned and checksum-validated. Noise, invalid candidates, and stale trailing data are discarded without polling the port.
- Serial `error` and `close` events reject the active response, retire the port, and leave the source closed. The base adapter then closes best-effort, marks the driver offline, and counts the failure as a bad read.
- The adapter owns reconnects using the normal read cadence (no per-driver retry timer). Failed opens become eligible after 1s, 2s, 5s, 10s, then 30s for all later failures. Concurrent polls and health checks share one pending open attempt.
- A response timeout resolves as `null`: it is a bad reading and can cause degraded state after repeated failures, but it does not close an otherwise open port. A rejected read signals a disconnected or failed port and therefore schedules reconnect.
- A successful open clears offline state; the next valid sample resets the reconnect sequence and clears degraded state.

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
