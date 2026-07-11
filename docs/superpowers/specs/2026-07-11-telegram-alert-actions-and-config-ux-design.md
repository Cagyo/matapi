# Telegram Alert Actions and Config UX Design

## Summary

Technical homeowners need to act on a critical sensor event without leaving the alert. Critical-alarm and flapping-fault messages will carry a single, sensor-specific `📋 View Logs` inline action. The action opens the existing recent-log delivery path for that sensor. No mute control is included.

## Interaction direction

This is a production-quality, text-native Telegram refinement. The interface remains compact and scannable: status icon and alert copy first, a single mitigating action below, and immediate callback acknowledgement. Navigation follows one grammar everywhere: `← Back`, `❌ Close`, and `❌ Cancel`.

## Flows

### Critical alert actions

1. A `critical` state-change notification is formatted as today.
2. The notification adapter attaches `📋 View Logs` with a compact callback payload that identifies the sensor.
3. Tapping the button acknowledges the callback, removes its keyboard to prevent repeated requests, and routes to the existing recent-log lookup and delivery behaviour.
4. Missing, archived, empty, and unreadable log cases use the existing localized `/logs` responses.

Flapping-fault notifications follow the same action pattern when the notification carries a sensor identity.

### GPIO selection

After a digital sensor name is entered, the wizard shows only unassigned Raspberry Pi BCM GPIO pins in 2–3-button rows. Selecting a pin advances to the electrical-mode step. A collision that occurs after the keyboard was rendered is handled by the existing domain-error path and returns the refreshed picker.

### Config explanations

The configuration summary and field prompts expand technical terms at their point of use:

- **Debounce:** ignore repeat signals for a short interval.
- **Active Low:** the sensor is triggered when its signal is low.
- **Pull: Up:** keeps an unconnected input stable at high voltage.

## Key states

- Critical and flapping alert with a sensor identity: one direct logs action.
- Alert without a sensor: no dead action button.
- No configured GPIO pins remaining: explain the condition and offer `← Back` / `❌ Cancel`.
- Stale selected GPIO pin: report the collision and refresh available choices.
- Every callback is acknowledged before processing; every closing/cancelling path clears stale keyboard state.

## Constraints

- Keep all user-facing copy in `src/locales/en.ts`.
- Keep bot handlers at the interface boundary and cross-context sensor access behind `SensorQueryPort`.
- Preserve the existing `/logs` output format and file fallback.
- Do not alter or stage unrelated script changes already present in the worktree.
