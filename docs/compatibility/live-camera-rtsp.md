# Live Camera RTSP Compatibility

## Acceptance status

Accepted with the two documented verification deviations below for the tested
RTSP combinations on the target Raspberry Pi.
RTSPS with a public-CA certificate remains best effort because no behavioral
camera fixture was available. Self-signed RTSPS is unsupported: the installed
FFmpeg cannot enforce a configured certificate fingerprint.

Acceptance was run on 2026-07-13 on `matapitest` (Debian 13, Linux 6.18.34,
aarch64, FFmpeg 7.1.5, 425,172 KiB RAM). The production stream identity was
`homeworker-stream`, with no login shell or home directory. Measurements use a
320x180, 10 fps synthetic source and include the converter plus the Node frame
gateway; they do not include a real camera or cloudflared.

## Published source matrix

| Source | Status | Fresh target-Pi evidence |
| --- | --- | --- |
| RTSP, H.264, TCP | Tested | 39 frames, 37 deliberately dropped, 3.764 s startup, 101.5 MiB peak RSS, 125.0% peak aggregate CPU |
| RTSP, H.264, UDP | Tested | 39 frames, 37 deliberately dropped, 3.764 s startup, 101.7 MiB peak RSS, 126.6% peak aggregate CPU; only UDP ports 24000-24001 observed |
| RTSP, H.265, TCP | Tested | 36 frames, 34 deliberately dropped, 4.484 s startup, 100.0 MiB peak RSS, 127.1% peak aggregate CPU |
| RTSP, H.265, UDP | Tested | 36 frames, 34 deliberately dropped, 4.647 s startup, 101.2 MiB peak RSS, 113.6% peak aggregate CPU; only UDP ports 24000-24001 observed |
| RTSPS, public CA and matching hostname | Best effort | Installed FFmpeg exposes strict CA and hostname verification, but no behavioral public-CA camera fixture was available |
| RTSPS, self-signed certificate | Unsupported | No fingerprint or pinned-public-key enforcement in the installed FFmpeg; trust-all fallback is forbidden |
| Audio, multiple converters, or more than two viewers | Unsupported | Outside the one-video-converter, two-viewer contract |

The tested converter queue was capped at two complete JPEG frames and dropped
old frames during a deliberate 1.5-second viewer stall. The selected Unix
socket was mode `0600` in the standalone harness. Production uses the documented
shared-group `0660` socket contract. The final run completed all six trials,
reported the expected cleanup contract, and left the network helper active.

Cloudflared 2026.7.1 installed successfully and its Pi connectivity diagnostic
completed during installation. A real external Quick Tunnel and Telegram iOS or
Android browser were not exercised in this RTSP acceptance run, so no
cloudflared CPU/RSS or end-to-end browser latency is claimed here.

## Isolation evidence

- `homeworker-stream-net.service` was enabled and active after acceptance. With
  no lease, its nftables output chain rejected all traffic owned by the stream
  UID. The synthetic matrix therefore ran in a controlled maintenance window;
  the empty rule was removed temporarily and the helper was always restarted.
- The installed FFmpeg unit makes `/opt/home-worker/.env` and
  `/opt/home-worker/data` inaccessible inside the service sandbox. A target-Pi
  systemd probe confirmed both paths were unreadable even though this legacy
  test deployment has overly broad `0644` file modes. A normal RTSP install also
  rejects an environment file unless it is a regular, single-link,
  worker-owned `0600` file.
- The source URL is removed from the short-lived config before FFmpeg starts and
  is passed through a sealed memory file. Ordinary local users can inspect the
  sanitized FFmpeg argv on this Pi, but it contains neither the URL nor camera
  credentials. Root remains able to inspect all processes; the stream identity
  can inspect its own memory and is therefore inside the residual trust boundary.
- Automated runtime tests reject DNS re-resolution changes, grant only validated
  literal addresses, reject invalid hostnames and CIDRs, and use the same fixed
  transport, TLS, port-range, video-only, timeout, and output-profile settings
  for source probes and live conversion.
- Credential persistence tests store only AES-GCM ciphertext, nonce, tag, and
  key version in SQLite. Export/import omits credentials, the encryption key is
  outside SQLite, sanitized errors and leases omit URLs, and Telegram tests
  delete the exact credential message before outcome replies without echoing it.

The original Task 5 checklist asked for all FFmpeg arguments to be invisible to
ordinary local users. That literal check is not met and is superseded here by a
secret-specific boundary: the visible argv is fixed and sanitized, while the
credential URL exists only in a sealed memory file owned by the stream process.
`ProtectProc=invisible` would restrict what the service can see; it would not
hide that service from host users. A global `hidepid` remount was not introduced
because it is a host-wide policy change with compatibility impact beyond this
feature.

## Automated verification exception

The required affected-suite command did not finish fully green. Its latest
unsandboxed run reported 597/601 tests: two pre-existing Motion multipart tests
failed with undici `terminated`/invalid-EOF errors, and two RTSP gateway tests
failed only when run in that parallel aggregate. The RTSP gateway file passed
12/12 immediately in isolation; installer tests passed 16/16; and `yarn build`
passed. An earlier whole-repository run reported 1279/1281 with the same two
Motion multipart failures, which also reproduce in their file alone. No green
all-tests gate is claimed. These failures are retained as a verification
deviation rather than changing unrelated user-owned Motion test work in this
plan.

## Rollback evidence

Automated lifecycle tests prove that disabling RTSP fences new starts, stops a
pending or active RTSP session, waits for late-start cleanup, and only then
persists the disabled feature. Motion sources do not consult the RTSP feature
gate and are not stopped by the RTSP hook.

On the target Pi, the PM2 daemon was fully restarted so the worker acquired the
new `homeworker-stream` group. The worker returned online, Motion remained
active, and the localhost Motion stream returned HTTP 200 with JPEG bytes after
the restart. The Pi's deployed worker predates this plan, so active-RTSP
stop-before-persist was verified by the current automated implementation tests,
not by mutating the legacy deployment database.

## Safe uninstall

1. Disable the `rtsp` feature through the normal feature control and wait for
   its active-session cleanup to finish.
2. Stop and disable `homeworker-stream-net.service`, stop any exact
   `homeworker-ffmpeg-stream@<uuid>.service` instances, and remove the
   `homeworker_stream` nftables table.
3. Remove only the installer-owned FFmpeg unit, network-helper unit, Polkit rule,
   tmpfiles rule, `/usr/lib/home-worker/live-stream-*` helpers, and
   `/etc/home-worker/live-stream-policy.json`; then reload systemd.
4. The camera and live-source metadata rows may remain. Removing the encrypted
   credential key does not reveal credentials, but makes stored ciphertext
   unusable; credentials must be re-entered before RTSP can become ready again.
5. Do not remove Motion, its configuration, recordings, camera rows, SQLite
   files, or cloudflared if another installed live-view source still uses them.

No uninstall step should delete or rewrite `data/*.db*`.
