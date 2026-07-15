# 10 — /config add|modify|remove Commands

## Dependencies
- 06-bot-core.md (bot instance, role guard, conversations plugin)
- 01-database.md (sensors table, sensors_archive table)
- 02-sensor-core.md (sensor registry, hot-reload)
- 00-overview.md (defaults.yml)

## Access
Admin only

---

## /config add

### Syntax
```
/config add
```

### Behavior
Conversational flow using grammY `conversations` plugin with inline keyboards.

### Flow

```
Admin: /config add
Bot: What type of sensor?
     [Digital] [UART] [MQTT] [Camera]
Admin: [Digital]
Bot: Sensor name?
Admin: front_door
Bot: GPIO pin number?
Admin: 17
Bot: Active high or low?
     [Active High] [Active Low]
Admin: [Active Low]
Bot: Pull resistor?
     [Pull Up] [Pull Down] [None]
Admin: [Pull Up]
Bot: Severity level?
     [Info] [Warning] [Critical]
Admin: [Info]
Bot: ✅ Sensor "front_door" added (GPIO 17, active low, pull up, info)
```

### Flow for UART type
```
Bot: What type of sensor?
Admin: [UART]
Bot: Sensor name?
Admin: co2_living
Bot: Serial port path?
Admin: /dev/serial0
Bot: Baud rate?
     [9600] [115200]
Admin: [9600]
Bot: Warning threshold (ppm)?
Admin: 800
Bot: Critical threshold (ppm)?
Admin: 1200
Bot: ✅ Sensor "co2_living" added (UART /dev/serial0, 9600 baud, warn: 800, crit: 1200)
```

### Inline Validations
- **Sensor name**: unique (check `sensors` table), non-empty, alphanumeric + underscore
- **GPIO pin**: range 0-27, not already used by another sensor
- **Serial port**: path exists on filesystem
- **Thresholds**: numeric, warning < critical
- Invalid input: bot replies with error and re-asks same question

### After Successful Add
1. Insert into `sensors` table with auto-generated UUID
2. Trigger sensor registry hot-reload
3. New driver initializes immediately

---

## /config modify <sensor_name>

### Syntax
```
/config modify <sensor_name>
```

### Behavior
Show current config, then conversational flow to change fields.

```
Admin: /config modify front_door
Bot: Current config for "front_door":
     Type: Digital
     GPIO: 17
     Active Low: Yes
     Pull: Up
     Debounce: 100ms
     Severity: Info
     
     What to change?
     [Name] [Pin] [Active] [Pull] [Debounce] [Severity] [Done]
Admin: [Severity]
Bot: New severity?
     [Info] [Warning] [Critical]
Admin: [Critical]
Bot: ✅ Severity updated to Critical. Anything else?
     [Name] [Pin] [Active] [Pull] [Debounce] [Severity] [Done]
Admin: [Done]
Bot: ✅ Sensor "front_door" updated.
```

### After Modify
1. Update `sensors` table
2. Trigger sensor registry hot-reload (driver recreated if pin/config changed)

---

## /config remove <sensor_name>

### Syntax
```
/config remove <sensor_name>
```

### Behavior
```
Admin: /config remove old_door
Bot: Remove sensor "old_door"? This will archive it.
     [Confirm] [Cancel]
Admin: [Confirm]
Bot: ✅ Sensor "old_door" archived.
```

### After Remove
1. Destroy sensor driver
2. Move row from `sensors` to `sensors_archive` (transaction)
3. GPIO pin freed for re-use

---

## Return Home behavior

Config uses the shared `rh:f:<c|t>` workflow code from
[06-bot-core.md](06-bot-core.md#authoritative-home-callback-pipeline). The
handler keeps `ConfigState` only in interface-local in-memory state.

| Workflow state | Return Home behavior |
|---|---|
| Add/modify/remove picker, prompt, retry, or confirmation | `rh:f:c` (`cancelPending`); delete the current `ConfigState`, then open a new Home. |
| Incremental modify result | `rh:f:c` (`cancelPending`); preserve the completed field mutation and delete only the remaining modify-menu state, then open a new Home. |
| Terminal config result/error with no live state | `rh:f:t` (`alreadyTerminal`); open a new Home directly. |

This cleanup does not roll back any completed mutation. Return Home remains
available to a registered user whose current role has changed; the new Home is
rendered for that current role.

---

## Error Cases

| Condition | Response |
|-----------|----------|
| Sensor name already exists (on add) | "❌ Sensor 'xyz' already exists" |
| GPIO pin in use (on add/modify) | "❌ GPIO 17 already used by 'front_door'" |
| Sensor not found (on modify/remove) | "❌ Sensor 'xyz' not found" |
| Invalid pin number | "❌ GPIO pin must be 0-27" |
| Conversation interrupted (bot restart) | "Previous operation was interrupted. Please start again." |
