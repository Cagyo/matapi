# 02 — Sensor Core

## Dependencies
- 01-database.md (sensors table, sensors_archive table)
- 00-overview.md (defaults.yml)
- ../architecture.md, ../naming-and-conventions.md, ../dependency-injection.md, ../ports-and-adapters.md (architecture rules)

## Driver Port

The driver contract is a **domain port** (`SensorDriverPort`) — no `I` prefix per [../naming-and-conventions.md](../naming-and-conventions.md). Lives in `src/sensors/domain/ports/sensor-driver.port.ts` (see [../architecture.md → Target layout](../architecture.md#target-layout-mapped-to-current-code)).

```typescript
// src/sensors/domain/ports/sensor-driver.port.ts
export const SENSOR_DRIVER_FACTORY = Symbol('SENSOR_DRIVER_FACTORY');

export interface SensorDriverPort {
  init(config: SensorConfig): Promise<void>;
  destroy(): Promise<void>;
  getState(): SensorReading;
  onEvent(callback: (event: SensorEvent) => void): void;
  healthCheck(): Promise<boolean>;
}

export type SensorDriverFactory = (type: SensorType) => SensorDriverPort;
```

Supporting domain types (each in its own file under `src/sensors/domain/`):

```typescript
export type SensorType = 'digital' | 'uart' | 'mqtt' | 'camera';
export type SensorSeverity = 'info' | 'warning' | 'critical';

export interface SensorConfig {
  id: string;
  name: string;
  type: SensorType;
  config: Record<string, unknown>;
  debounceMs: number;
  severity: SensorSeverity;
}

export interface SensorReading {
  value: string | number | boolean;
  timestamp: Date;       // produced by adapter; application code must use ClockPort, not new Date()
  raw?: unknown;
}

export interface SensorEvent {
  sensorId: string;
  type: 'state_change' | 'threshold' | 'error';
  oldValue?: unknown;
  newValue: unknown;
  timestamp: Date;
}
```

## Sensor Registry (application/)

`SensorRegistry` is an **application service** (`sensors/application/sensor-registry.service.ts`). It depends on `SensorRepositoryPort` for persistence and `SensorDriverFactory` for driver instantiation — never on Drizzle, never on a concrete driver class.

- Backed by the `sensors` table via `SensorRepositoryPort`.
- Loaded into memory on startup (including `lastValue` so `/status` is instant).
- The registry exposes a `SensorQueryPort` for other contexts (e.g. telegram); cross-context callers **must not** query the `sensors` table directly.

### `lastValue` cadence

- Digital: updated synchronously on every state transition.
- UART/CO2: updated in memory on every read; persisted to `sensors.lastValue` on each flush cycle (see 04-sensor-uart.md).
- The `/status` command always reads from the registry's in-memory snapshot, never the DB directly.

### Hot-Reload Flow

Triggered by a `ReloadSensorsUseCase` (called from `/config add|modify|remove` and `/import_config`), not by polling:

1. Bot handler invokes the use case.
2. Use case writes to SQLite via `SensorRepositoryPort` (transactional).
3. Use case calls `SensorRegistry.reload()`.
4. Registry diffs in-memory state vs repo; tears down removed/changed drivers; initialises new/changed drivers.
5. Reload is queued between event processing cycles — never mid-event.

### State vs Events

- **State** (`sensors.lastValue` + `sensors.lastValueAt`): current value, written by the registry/driver, consumed by `/status`.
- **Events** (`events` table): state transitions, written through `EventRepositoryPort`, consumed by notifications.

## Driver Selection (composition root)

Driver selection is environment-driven and lives in `sensors.module.ts` per [../dependency-injection.md](../dependency-injection.md):

```typescript
// src/sensors/sensors.module.ts
@Module({
  providers: [
    SensorRegistry,
    PigpioGateway,
    {
      provide: SENSOR_DRIVER_FACTORY,
      useFactory: (pigpio: PigpioGateway): SensorDriverFactory =>
        process.env.NODE_ENV === 'development'
          ? () => new MockGpioAdapter()
          : (type) => buildAdapterFor(type, pigpio),
      inject: [PigpioGateway],
    },
  ],
  exports: [SensorRegistry, SENSOR_QUERY],
})
export class SensorModule {}
```

Use a Symbol token (`SENSOR_DRIVER_FACTORY`) — never a string token like `'GPIO_DRIVER'` ([../dependency-injection.md → Token rules](../dependency-injection.md#token-rules)).

## Mock GPIO Adapter (development)

`MockGpioAdapter` is a real adapter that ships in `src/sensors/infrastructure/` alongside `DigitalGpioAdapter` — not a test fixture ([../testing.md → Tier 2](../testing.md#tier-2--use-case-application)).

```typescript
// src/sensors/infrastructure/mock-gpio.adapter.ts
export class MockGpioAdapter implements SensorDriverPort {
  private state = new Map<number, 0 | 1>();
  private listeners = new Map<number, (v: 0 | 1) => void>();

  simulateChange(pin: number, value: 0 | 1): void {
    this.state.set(pin, value);
    this.listeners.get(pin)?.(value);
  }
  // init/destroy/getState/onEvent/healthCheck …
}
```

In dev mode, a small web panel at `http://localhost:4000/dev/simulate` (see 26-dev.md) calls `simulateChange()` to fire the same pipeline as real GPIO.

## Error Handling

Domain failures are typed errors in `sensors/domain/errors/` ([../error-handling.md](../error-handling.md)):

- pigpiod down on startup: adapter throws `DriverUnavailableError`; this is the explicit recoverable initialization exception. The registry keeps the configured driver active, registers its event listener, and logs it offline so its gateway subscription can rebind after pigpiod later connects. The application notifies admin via `NotifierPort`, while the bot still starts. Invalid configuration and every other initialization failure remain skipped and logged.
- Mid-runtime driver failure: adapter raises through `onEvent` error path; registry marks sensor offline, notifies admin.
- `/status` shows offline sensors: `🚪 front_door: ⚠️ OFFLINE (driver error)` (copy in [../../src/locales/en.ts](../../src/locales/en.ts)).
