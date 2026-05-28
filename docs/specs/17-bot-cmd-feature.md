# 17 — /feature enable|disable Command

## Dependencies
- 06-bot-core.md (bot instance, role guard)
- 01-database.md (features table)

## Access
Admin only

## Syntax
```
/feature enable <feature_name>
/feature disable <feature_name>
/feature list
```

## Available Features
- `digital` — GPIO sensors
- `uart` — CO2 serial sensor
- `zigbee` — Zigbee2MQTT gateway
- `motion` — Motion camera
- `neobox` — Neobox intercom
- `4g` — 4G failover

## Behavior

### /feature list
Show all features with status:
```
🔧 Features

✅ digital — enabled (installed)
✅ uart — enabled (installed)
❌ zigbee — disabled (installed)
⬜ motion — disabled (not installed)
⬜ neobox — disabled (not installed)
⬜ 4g — disabled (not installed)
```

### /feature enable <name>
1. Check if feature exists
2. Check if deps are installed (`features.installed = true`)
3. If not installed: reject with message
4. If installed: set `enabled = true`, load the module

### /feature disable <name>
1. Set `enabled = false`
2. Unload the module (stop drivers, disconnect services)

## Key Constraint
Bot only toggles features whose system dependencies are already installed. It does **not** install deps at runtime. To install new feature deps: re-run install script or SSH in.

## Output
```
✅ Feature 'uart' enabled.
```
```
✅ Feature 'zigbee' disabled.
```

## Error Cases
| Condition | Response |
|-----------|----------|
| Feature not found | "❌ Unknown feature 'xyz'. Use /feature list." |
| Deps not installed | "❌ Feature 'motion' requires system dependencies. Re-run the install script with motion enabled." |
| Already enabled | "ℹ️ Feature 'uart' is already enabled" |
| Already disabled | "ℹ️ Feature 'uart' is already disabled" |
