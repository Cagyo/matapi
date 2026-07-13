# Live Camera MJPEG Compatibility

## Status

Manual hardware/client acceptance is **PENDING**. This implementation environment has no Raspberry Pi camera, Motion daemon, real Cloudflare Quick Tunnel, Telegram iOS client, or Telegram Android client. The table below deliberately makes no claim about those systems.

The live view is experimental. It uses Motion's localhost-only MJPEG stream, one shared five-minute session, and short-lived viewer URLs delivered as ordinary Telegram URL buttons.

## Required test configuration

- Raspberry Pi 3+ running the production Node 20/PM2 deployment.
- Motion configured with `stream_port 8081` and `stream_localhost on`.
- The configured camera is enabled and has type `motion`.
- The experimental live-stream capability is installed and enabled.
- `cloudflared tunnel diag` succeeds for the worker user.
- Two registered Telegram users are available for shared-stop testing.
- Telegram iOS and Android clients are both available.
- Never paste a watch URL, viewer token, bot token, or full chat ID into this document.

## Manual acceptance checklist

Run every item on the target Pi and record dated, sanitized evidence in the table.

- [ ] Confirm Motion listens only on loopback at port 8081 and returns a moving MJPEG stream locally.
- [ ] Confirm `/camera live` selects the first enabled Motion camera and displays localized experimental/opening copy.
- [ ] Confirm `/camera live <camera>` resolves the configured camera by name and returns a normal **Watch live** URL button.
- [ ] Confirm the Camera dashboard **Live** button opens the default camera.
- [ ] Trigger a motion alert and confirm its callback data is only `cam:live:<cameraId>`; it must contain no hostname, URL, or token.
- [ ] As an unregistered private-chat user, invoke the command and callback; confirm no watch URL or camera detail is returned.
- [ ] Open the URL from Telegram iOS and confirm continuously updating live frames rather than a static image or download.
- [ ] Open a separately issued URL from Telegram Android and confirm continuously updating live frames.
- [ ] Confirm both authorized viewers can watch the same global session without starting a second `cloudflared` process.
- [ ] Wait five minutes without stopping; confirm the tunnel/session stops, old viewer URLs no longer stream, and all registered watch messages are deleted or made inaccessible on a best-effort basis.
- [ ] Start a new session, then have the second registered user run `/camera stop_stream`; confirm the shared stream stops for both users and both watch messages are cleaned up.
- [ ] Run `/camera stop_stream` again and confirm the localized no-active-session response.
- [ ] During an active session, verify the gateway exposes only loopback listeners locally and that no external Motion port is opened.
- [ ] After expiry and explicit stop, confirm no worker-owned `cloudflared` process, MJPEG upstream, viewer response, HTTP listener, metrics listener, or live-stream lease remains.
- [ ] Create a controlled stale lease for a worker-owned test process, restart the worker, and confirm boot recovery stops only the identity-matched process and clears the lease.
- [ ] Repeat stale-lease recovery with an identity mismatch and confirm the unrelated process is not killed and the sanitized admin alert is emitted.
- [ ] Inspect worker logs from open, join, failure, expiry, stop, and recovery; confirm they contain no watch URL, viewer token, Telegram bot token, or full chat ID.
- [ ] Measure worker and `cloudflared` RSS/CPU at idle, with one viewer, with two viewers, and after cleanup; confirm combined memory remains below the 512 MB PM2 budget and returns near baseline after cleanup.
- [ ] Reboot the Pi with no active lease and confirm the worker, Motion, bot handlers, and a fresh live-view request recover normally.

## Evidence table

| Check                                                                           | Environment / client              | Result                     | Evidence                                                    |
| ------------------------------------------------------------------------------- | --------------------------------- | -------------------------- | ----------------------------------------------------------- |
| Focused automated handler, cleanup, registration, live-stream, and locale tests | Local CI-compatible environment   | PASS                       | 39 files / 272 tests passed with scoped loopback permission. |
| TypeScript production build                                                     | Local CI-compatible environment   | PASS                       | `yarn build` exited 0.                                      |
| Motion localhost MJPEG frames                                                   | Raspberry Pi / Motion             | PENDING                    | No target device available.                                 |
| `/camera live` and named-camera flow                                            | Raspberry Pi / Telegram           | PENDING                    | No real bot or tunnel exercised.                            |
| Dashboard Live and motion-alert callback                                        | Raspberry Pi / Telegram           | PENDING                    | No real bot or motion alert exercised.                      |
| Registered/unregistered authorization                                           | Raspberry Pi / Telegram           | PENDING                    | No real Telegram identities exercised.                      |
| Live playback                                                                   | Telegram iOS                      | PENDING                    | No iOS client exercised.                                    |
| Live playback                                                                   | Telegram Android                  | PENDING                    | No Android client exercised.                                |
| Five-minute expiry and watch-message deletion                                   | Raspberry Pi / Telegram           | PENDING                    | No wall-clock hardware run performed.                       |
| Shared stop and no-active response                                              | Raspberry Pi / two Telegram users | PENDING                    | No multi-user real-bot run performed.                       |
| Process/listener/metrics/lease cleanup                                          | Raspberry Pi                      | PENDING                    | No real `cloudflared` or Motion process inspected.          |
| Stale-lease boot recovery                                                       | Raspberry Pi                      | PENDING                    | No controlled reboot/process recovery performed.            |
| Sanitized production logs                                                       | Raspberry Pi                      | PENDING                    | No production log capture reviewed.                         |
| Worker + `cloudflared` RSS/CPU                                                  | Raspberry Pi 3+                   | PENDING                    | No measurements available; do not infer from desktop tests. |
| Reboot recovery                                                                 | Raspberry Pi                      | PENDING                    | No target reboot performed.                                 |

## Resource measurements

Fill this only from the target Pi. Use the same sampling command and interval for every row.

| State                      | Worker RSS (MiB) | `cloudflared` RSS (MiB) | Worker CPU (%) | `cloudflared` CPU (%) | Notes |
| -------------------------- | ---------------: | ----------------------: | -------------: | --------------------: | ----- |
| Idle baseline              |          PENDING |                 PENDING |        PENDING |               PENDING |       |
| One viewer                 |          PENDING |                 PENDING |        PENDING |               PENDING |       |
| Two viewers                |          PENDING |                 PENDING |        PENDING |               PENDING |       |
| Five minutes after cleanup |          PENDING |                 PENDING |        PENDING |               PENDING |       |

## Acceptance decision

**PENDING — manual acceptance has not been run.** Promote this result only after every checklist item has dated evidence and all resource figures are measured on the supported Pi deployment.
