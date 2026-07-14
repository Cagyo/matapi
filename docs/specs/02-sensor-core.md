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

## Shared dashboard classification, paging, and health probe

Home and `/status` share
[`src/sensors/domain/sensor-state-classifier.ts`](../../src/sensors/domain/sensor-state-classifier.ts):
`classifySensorState` returns `unknown`, `normal`, `warning`, or `critical`
from the persisted sensor state and configuration. This is the sole classifier
for `/status`, Home/Sensors, and Home attention ordering, so one surface cannot
silently disagree with another. Names are normalized as NFKC, trimmed, and
lower-cased before ordering.

`SensorQueryPort.listDashboardPage({ page, pageSize: 8 })` builds the Sensors
page through
[`src/sensors/domain/sensor-dashboard-page.ts`](../../src/sensors/domain/sensor-dashboard-page.ts).
It lists enabled sensors in deterministic normalized-name order with immutable
sensor ID as the tie-breaker, returns eight items per page, and clamps an
invalid page to the last valid page (page zero for an empty set). The page
response reports the requested page, effective page, count, total, and whether
it was clamped; a refresh preserves the selected alphabetical page.

Live reporting health is a separate application port,
`SensorHealthPort` (`SENSOR_HEALTH`) in
[`src/sensors/application/ports/sensor-health.port.ts`](../../src/sensors/application/ports/sensor-health.port.ts).
`SensorRegistryService.probe` resolves every requested active driver as
`online`, `offline`, `missing`, `failed`, or `timed_out`. Home's refresh budget
is `SENSOR_HEALTH_PROBE_TIMEOUT_MS = 5_000`; a timeout releases the caller but
cannot cancel third-party driver I/O. A current driver health check is shared
while it is in flight, and `RefreshHomeMonitoringUseCase` makes concurrent
Home checks a system-wide single flight.

`/menu` **does not probe**. It renders persisted state plus the cached Home
health snapshot. Only the Home `Check now` action invokes the bounded probe;
its snapshot is process-local, complete only when all enabled IDs are covered,
and fresh for two minutes.

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

## MQTT Reconnect Policy

Each MQTT sensor may set `reconnectMs` to an integer from 1,000 to 300,000 ms.
When absent, `MQTT_DEFAULT_RECONNECT_MS` supplies the value; an invalid environment
value falls back to 5,000 ms. MQTT.js owns reconnect attempts. The shared pool
sets `connectTimeout: 10_000`, `resubscribe: false`, and
`reconnectOnConnackError: false`; each MQTT adapter subscribes once and validates
SUBACK after every successful `connect` event.

Sensors sharing a broker URL share one MQTT.js client and therefore must resolve
to identical connection-level reconnect and authentication options. A conflict is
rejected as sensor configuration invalid rather than silently retaining the first
sensor's settings. Error messages must not expose broker credentials.

### MQTT Availability Events

Each MQTT sensor adapter observes the pooled client's `offline`, `close`, and
`connect` events. `offline` and `close` share one deduplicated timer. If the
client remains unavailable for `MQTT_OFFLINE_ALERT_MS` (default 60,000 ms), the
adapter emits one localized error event. The next `connect` clears the outage
state, emits one localized recovery event only after a signaled prolonged outage,
then performs its normal subscribe-and-SUBACK check. A shorter outage emits no
availability event.

MQTT.js remains the sole reconnect owner. The adapter never calls `reconnect()`
or creates a second retry loop.
