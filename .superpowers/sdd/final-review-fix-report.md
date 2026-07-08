# Final Review Fix Report

Fixed the install/setup review items for the Motion feature:

- `scripts/install-feature.sh` now appends the generated sudoers rules to `/etc/sudoers.d/homeworker-motion` instead of the legacy `/etc/sudoers.d/homeworker`.
- The Motion hook cleanup now removes broader prior definitions with `^[#[:space:]]*on_(event_start|event_end|picture_save)[[:space:]]` before writing the quoted hooks.
- `docs/specs/20-camera.md` now documents the dedicated per-feature sudoers file and includes both `/usr/bin/systemctl` and `/bin/systemctl` start/stop/restart rules.
- `src/camera/infrastructure/motion-daemon.adapter.ts` now references `/etc/sudoers.d/homeworker-motion`.

Verification run:

- `bash -n scripts/install-feature.sh`
- `grep -nF '^[#[:space:]]*on_(event_start|event_end|picture_save)[[:space:]]' scripts/install-feature.sh`
- `grep -c 'systemctl start motion' scripts/install-feature.sh`
- `grep -n 'visudo -c' scripts/install-feature.sh`
- `grep -n 'sudoers.d/homeworker-motion' scripts/install-feature.sh`
- `grep -n '/etc/sudoers.d/homeworker-motion' docs/specs/20-camera.md src/camera/infrastructure/motion-daemon.adapter.ts`
