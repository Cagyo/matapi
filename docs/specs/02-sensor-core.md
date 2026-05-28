# 02 — Sensor Core

## Dependencies
- 01-database.md (sensors table, sensors_archive table)
- 00-overview.md (defaults.yml)

## Driver Interface

```typescript
// src/sensors/sensor.interface.ts

export interface SensorConfig {
  id: string;
  name: string;
  type: string;
  config: Record<string, any>;
  debounceMs: number;
  severity: 'info' | 'warning' | 'critical';
}

export interface SensorReading {
  value: string | number | boolean;
  timestamp: Date;
  raw?: any;
}

export interface ISensorDriver {
  init(config: SensorConfig): Promise<void>;
  destroy(): Promise<void>;
  getState(): SensorReading;
  onEvent(callback: (event: SensorEvent) => void): void;
  healthCheck(): Promise<boolean>;
}

export interface SensorEvent {
  sensorId: string;
  type: 'state_change' | 'threshold' | 'error';
  oldValue?: any;
  newValue: any;
  timestamp: Date;
}
```

## Sensor Registry

- Backed by `sensors` SQLite table
- Loaded into memory on startup (including `lastValue` for immediate `/status`)
- Each sensor type maps to a driver class

### Hot-Reload Flow

1. Bot command modifies SQLite
2. SensorRegistry detects change (polling or event-driven)
3. Diffs current in-memory state vs DB
4. Tears down removed/changed drivers
5. Initializes new/changed drivers
6. Changes queued and applied between event processing cycles (not mid-event)

### State Tracking

Two concepts:
- **State** (`sensors.lastValue` + `sensors.lastValueAt`): current value, updated on every reading, used by `/status`
- **Events** (`events` table): state transitions, used for notifications and offline queue

## Driver Selection

```typescript
providers: [{
  provide: 'GPIO_DRIVER',
  useFactory: () =>
    process.env.NODE_ENV === 'development'
      ? new MockGpioDriver()
      : new PigpioDriver(),
}]
```

## Mock GPIO Driver (Development)

```typescript
class MockGpioDriver implements ISensorDriver {
  private state = new Map<number, 0 | 1>();

  simulateChange(pin: number, value: 0 | 1) {
    this.state.set(pin, value);
    this.listeners.get(pin)?.(value);
  }
}
```

In dev mode, expose web panel at `http://localhost:3001/dev/simulate` with toggle buttons per sensor.

## Error Handling

- If pigpiod is down on startup: start bot without sensors, notify admin
- Mid-runtime driver failure: mark sensor as `offline`, notify admin
- `/status` shows offline sensors: `🚪 front_door: ⚠️ OFFLINE (driver error)`
