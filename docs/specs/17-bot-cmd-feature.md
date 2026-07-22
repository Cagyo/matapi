# 17 — Telegram Feature Management

## Dependencies
- 06-bot-core.md (private chat, role guard, workflow-return receipts)
- 01-database.md (features and feature-install jobs)
- 25-install.md (root-owned feature installer artifacts)
- ../superpowers/specs/2026-07-22-telegram-feature-management-design.md (detailed design)

## Access

Admin only for every feature-management screen and command.

## Supported features

- `digital` — GPIO sensors
- `uart` — CO₂ serial sensor
- `zigbee` — MQTT-backed sensors and local Mosquitto dependency
- `motion` — Motion camera
- `rtsp` — live camera streams

Legacy `neobox` and `4g` rows may remain in the database but are unavailable and hidden from selectors.

## Commands

```text
/feature list
/feature install <name>
/feature enable <name>
/feature disable <name>
```

`/feature list` opens the interactive feature list. Mutation commands open the same localized detail and action-specific confirmation flow as buttons; they never mutate state directly.

## States and valid actions

| State | Valid action |
|---|---|
| Not installed | Install & enable |
| Installed and disabled | Enable |
| Installed and enabled | Disable |
| Needs attention | Verify again or local guidance |

Only one dependency installation runs at a time. Enable and disable are normal application use cases and do not invoke the privileged installer.

## Install

Installation runs through the fixed root-owned helper defined by the detailed design. The helper accepts only an allowlisted feature identifier, performs fixed routines, and writes a bounded result. The worker independently verifies readiness before setting `installed=true` and `enabled=true`.

A failed or uncertain installation releases the global install slot. Any attention state applies only to the affected feature.

## Enable and disable

Enable requires installed, verified dependencies. Disable stops registered feature work, retains `installed=true`, and never removes packages.

Feature state gates both menus and runtime work:

- Digital, UART, and MQTT drivers are filtered at sensor-registry boot/reload and torn down on disable.
- Motion watcher/daemon operations are gated by the Motion feature.
- RTSP source and live-stream operations are gated by the RTSP feature.
- Stale callbacks recheck state before invoking any effect.

Mutations use the existing workflow-return receipt, current-role rechecks, expected-state CAS, localized outcomes, and the disclosed restart scope. Telegram delivery failure never keeps an install job active.

## First-install consistency

The installer rewrites `features.json.enabled` to contain only features whose installation and verification succeeded. The worker seeder must not mark a selected-but-failed feature installed or enabled.

## Detailed design

The authoritative behavior, privileged boundary, restart matrix, recovery flow, and acceptance criteria are in [Telegram Feature Management Design](../superpowers/specs/2026-07-22-telegram-feature-management-design.md).
