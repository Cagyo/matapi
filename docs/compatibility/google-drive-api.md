# Google Drive API compatibility

Checked: 2026-07-29

The archive infrastructure owns Google SDK and HTTP details. Application and
domain code consume provider-neutral ports and error types only.

- Device flow discovery endpoints must equal
  `https://oauth2.googleapis.com/device/code` and
  `https://oauth2.googleapis.com/token`.
- Device polling handles `authorization_pending`, `slow_down`, `access_denied`,
  `admin_policy_enforced`, `invalid_client`, `invalid_grant`, and `org_internal`.
- The `drive.file` scope is available to TVs and Limited Input devices, and
  approval returns a refresh token.
- Resumable chunks are 256 KiB multiples. Status uses an empty `PUT` with
  `Content-Range: */<size>`; `200`/`201` complete, `308` resumes from the
  server `Range`, and `404` restarts the session.
- Google documents one-week session expiry; Home Worker expires a session
  locally after six days.
- Binary Drive files expose `sha256Checksum` and `headRevisionId`; deletion has
  no revision precondition.
