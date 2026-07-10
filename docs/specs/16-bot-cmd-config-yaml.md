# 16 — /export_config, /import_config Commands

## Dependencies
- 06-bot-core.md (bot instance, role guard)
- 01-database.md (sensors table, cameras table, features table)

---

## /export_config

### Access
Admin only

### Syntax
```
/export_config
```

### Behavior
1. Read all sensors, cameras, features from SQLite
2. Generate YAML file
3. Send as document attachment

### Output YAML structure
```yaml
sensors:
  - name: front_door
    type: digital
    config:
      pin: 17
      activeLow: true
      pull: up
    debounce_ms: 10000
    severity: info
  - name: co2_living
    type: uart
    config:
      port: /dev/serial0
      baudRate: 9600
      thresholds:
        warning: 800
        critical: 1200
    debounce_ms: 0
    severity: warning

cameras:
  - name: front_door
    type: motion
    config:
      motionConfigPath: /etc/motion/motion.conf

features:
  - name: digital
    enabled: true
  - name: motion
    enabled: true
```

### File sent as
`home-worker-config-2026-04-08.yml`

---

## /import_config

### Access
Admin only

### Syntax
```
/import_config
```
Then user uploads a `.yml` file.

### Behavior
1. Bot replies: "Send me a YAML config file."
2. User uploads file
3. Bot parses and validates

### Validation Rules

**Per sensor:**
- `name`: required, non-empty, alphanumeric + underscore
- `type`: required, one of `digital`, `uart`, `mqtt`, `camera`
- `config`: required, must contain type-specific fields:
  - Digital: `pin` (0-27 integer)
  - UART: `port` (string), `baudRate` (valid standard: 9600, 19200, 38400, 57600, 115200)
  - UART thresholds: numeric, warning < critical
  - MQTT: non-empty `topic`; optional `qos` is 0, 1, or 2; optional `format` is `zigbee2mqtt`, `tasmota`, `json`, or `auto`; optional `reconnectMs` is a finite non-negative integer (0 is allowed)
  - Camera: `type` is `rtsp`, `mjpeg`, `usb`, or `libcamera`; RTSP/MJPEG require a non-empty `url`; optional `snapshotCacheTtlMs` is a finite non-negative integer; optional resolution `width` and `height` are positive integers
- `severity`: if present, one of `info`, `warning`, `critical`
- `debounce_ms`: if present, non-negative integer

The same MQTT and camera shape checks run when sensor configs are created directly,
before parser-specific defaults, environment resolution, or camera storage-path
resolution are applied.

**Cross-sensor:**
- No duplicate sensor names
- No duplicate GPIO pins across digital sensors

**On validation failure:**
```
❌ Config validation failed:

• Sensor 'door_3': invalid pin number 99 (must be 0-27)
• Sensors 'door_1' and 'window_2' both use GPIO pin 17
• Sensor 'co2': missing required field 'port'

Fix and re-upload.
```
No changes written to DB.

**On validation success:**
Bot shows summary of changes vs current config:
```
📋 Import summary:

➕ Add: door_3, window_1
🔄 Update: front_door (pin 17→22), co2_living (thresholds changed)
🗄️ Archive: old_sensor (exists in DB but not in import)

Apply changes? [Apply] [Cancel]
```

**On Apply:**
1. Wrap all changes in a single SQLite transaction
2. Archive removed sensors (move to `sensors_archive`)
3. Update changed sensors
4. Insert new sensors
5. Trigger sensor registry hot-reload
6. Reply: "✅ Config imported. 2 added, 1 updated, 1 archived."

**On Cancel:**
"Import cancelled. No changes made."

### YAML Conflict Resolution
Import is a full replacement — sensors in DB but not in YAML get archived. This is shown clearly in the summary before confirmation.

### Error Cases
| Condition | Response |
|-----------|----------|
| No file uploaded | "Send me a YAML file." (wait for upload) |
| File is not YAML | "❌ Invalid file format. Send a .yml file." |
| YAML parse error | "❌ YAML parse error: [details]" |
| Validation fails | Detailed error list (see above) |
| DB write fails | "❌ Import failed: [error]. No changes were made." (transaction rollback) |
