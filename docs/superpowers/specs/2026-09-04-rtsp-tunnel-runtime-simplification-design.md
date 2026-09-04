# RTSP Tunnel Runtime Simplification — Design

## Status

Approved in discussion on 2026-09-04. This design supersedes the privileged
RTSP network-policy, policy-summary, and install-time Cloudflare diagnostic
parts of the 2026-08-13 RTSP design. Its camera-source workflow, encrypted
credential storage, Telegram authorization, localization, and bounded session
lifecycle remain in force unless this document says otherwise.

Implementation has not started. The next artifact is an implementation plan.

## Problem

The RTSP feature installer currently combines several separate concerns:

- installing FFmpeg and `cloudflared`;
- creating the FFmpeg runtime user and systemd unit;
- discovering directly connected LAN routes;
- generating policy, summary, and digest artifacts;
- installing a dynamic nftables helper and inspector;
- starting a persistent network-policy service; and
- dropping from the privileged installer to the worker user to run
  `cloudflared` diagnostics.

On the test Pi, the last step failed inside the transient privileged installer
because PAM-backed `runuser` could not change to the worker UID. The same
command and the same systemd restrictions later succeeded in isolation, so the
failure is not a missing `cloudflared` executable. The broad result is still
clear: an installation path that must coordinate PAM, a transient root unit,
three policy artifacts, nftables, route discovery, and an application restart
has too many failure modes for the threat model.

Remote viewing is nevertheless a core requirement. The Pi is behind NAT on a
private network, and neither the worker nor the RTSP camera can accept useful
inbound Internet traffic. The design must therefore retain an outbound tunnel.
It must prove that a real RTSP-derived frame is reachable through that tunnel
before the bot gives the URL to a user.

## Goals

- Keep temporary remote live view through an outbound Cloudflare Quick Tunnel.
- Require no router port forwarding, public Pi address, VPN, or inbound LAN
  firewall opening.
- Make the public readiness gate end to end: camera, FFmpeg, local viewer,
  Cloudflare tunnel, and a returned RTSP-derived JPEG must all work.
- Keep the viewer origin bound only to loopback.
- Keep links random, per-user, revocable, and short-lived.
- Run FFmpeg in a dedicated, resource-bounded, unprivileged systemd service.
- Run `cloudflared` as the ordinary worker user, not through a privileged
  install-time user switch.
- Replace kernel-enforced dynamic destination policy with simple, explicit
  application validation suitable for an administrator-managed private LAN.
- Make first install, retry, reinstall, and cleanup idempotent and recoverable.

## Non-goals

- Exposing the raw `rtsp://` protocol through Cloudflare.
- A permanent public hostname, custom domain, named tunnel, or Cloudflare
  Access policy.
- Production-grade uptime guarantees from TryCloudflare.
- Supporting public, multicast, loopback, unspecified, or link-local RTSP
  destinations.
- Removing authentication, credential encryption, redaction, process
  isolation, or session limits.
- Supporting more than the existing small bounded viewer count.

## Meaning of “RTSP available through the tunnel”

The camera continues to speak RTSP only on the home LAN. FFmpeg converts that
feed to JPEG frames. The worker serves an HTML/MJPEG viewer on
`127.0.0.1:<ephemeral-port>`, and `cloudflared` publishes that HTTP origin at a
temporary HTTPS `*.trycloudflare.com` address.

The tunnel therefore carries the rendered live view, not the raw RTSP socket:

```text
RTSP camera on private LAN
        |
        | rtsp:// or rtsps://
        v
sandboxed FFmpeg systemd instance
        |
        | JPEG frames over a restricted Unix socket
        v
worker HTTP viewer on 127.0.0.1
        |
        | outbound Cloudflare Quick Tunnel
        v
temporary https://<random>.trycloudflare.com/watch/<token>
        |
        v
authorized Telegram user outside the LAN
```

A session is tunnel-ready only after the worker downloads one complete,
bounded JPEG from a private one-time probe route through the public
`trycloudflare.com` hostname. A successful HTML response alone is not enough.

## Decisions

1. Cloudflare Quick Tunnel remains the remote transport for a live-view
   session. It is created on demand and destroyed with the session.
2. The worker does not return or send a public URL until an end-to-end frame
   probe through that URL succeeds.
3. The public service is the loopback HTTP/MJPEG viewer. Raw RTSP is never
   bound publicly or forwarded directly.
4. `cloudflared` runs as a child of the unprivileged worker in its own process
   group with a deliberately isolated configuration environment.
5. FFmpeg remains in a separate systemd template unit under the dedicated
   stream user, with the existing resource and syscall restrictions.
6. Runtime RTSP destination validation stays in the application and runs
   immediately before every probe or stream start. The dynamic nftables
   policy layer is removed.
7. Install-time `cloudflared tunnel diag` and privileged `runuser`/`setpriv`
   execution are removed. Runtime session startup is the authoritative tunnel
   connectivity test.
8. Legacy policy files, the network helper, and the network-policy systemd unit
   are removed during an idempotent upgrade without deleting camera sources or
   encrypted credentials.
9. A failed install remains retryable as an install. Feature state must never
   trap an uninstalled RTSP feature behind a repair-only action.

## Runtime Architecture

### 1. Source validation

Before a connection probe or live session starts, the application:

- accepts only `rtsp:` and `rtsps:` URLs;
- rejects embedded output/control options and malformed hosts;
- resolves every hostname using the system resolver;
- rejects an empty answer set or mixed public/private answers;
- permits only RFC 1918 IPv4 ranges and private IPv6 ULA addresses;
- rejects loopback, link-local, multicast, unspecified, documentation, and
  publicly routable addresses; and
- repeats resolution immediately before starting FFmpeg rather than trusting
  an address cached when the source was saved.

This is an application safety boundary, not a hostile-network sandbox. The
administrator controls camera configuration and the deployment is on a trusted
home LAN. Removing the nftables layer accepts DNS-rebinding and compromised-LAN
risk that is disproportionate to defend against in this product. URL parsing,
private-address validation, admin-only configuration, and FFmpeg isolation are
retained because they are cheap and prevent common mistakes.

### 2. FFmpeg runtime

The worker starts only a fixed, validated
`homeworker-ffmpeg-stream@<uuid>.service` instance through the existing narrow
authorization boundary. The unit:

- runs as the dedicated stream user and group;
- has no ambient or effective Linux capabilities;
- uses `NoNewPrivileges`, a private temporary directory, a read-only system,
  and the current systemd hardening controls;
- permits only the address families required for RTSP and the Unix output
  socket;
- enforces memory, process, and runtime limits; and
- writes JPEG frames only to the per-session Unix socket under the restricted
  runtime directory.

The unit no longer requires or orders itself after
`homeworker-stream-net.service`.

The worker waits for one syntactically complete JPEG frame before opening the
public tunnel. It retains one immutable, bounded frame snapshot and its digest
for each startup probe attempt; normal delivery continues to use bounded
per-viewer queues.

### 3. Loopback viewer

The worker starts the viewer on an operating-system-selected port bound
explicitly to `127.0.0.1`. It must fail closed if the address is not loopback.
No LAN interface receives a listening socket.

The viewer exposes three authenticated route types:

- `/watch/<viewer-token>`: minimal HTML shell;
- `/mjpeg/<viewer-token>`: the bounded MJPEG response; and
- `/probe/<startup-token>`: a one-shot copy of the latest complete JPEG used
  only by tunnel startup.

Tokens are 256-bit random values represented with base64url. Only token hashes
are stored. Unknown, malformed, duplicated, expired, or revoked tokens return
the same not-found response. Query strings and redirects are rejected. Security
headers continue to disable caching and referrer leakage and prevent framing.

The startup token is separate from every user token. It exists only while the
tunnel readiness check is running, is accepted at most once, and is removed on
success, timeout, cancellation, or any failure.

### 4. Quick Tunnel process

After the local frame and loopback listener are ready, the worker starts:

```text
cloudflared tunnel --url http://127.0.0.1:<port> --no-autoupdate
```

The exact CLI argument order will be verified against the installed
`cloudflared` version during implementation. The process:

- runs under the worker UID without `sudo`, PAM, `runuser`, or `setpriv`;
- runs in a detached process group so cleanup can terminate its descendants;
- receives a minimal environment with an isolated, worker-owned `HOME` and
  config directory containing no `config.yml` or `config.yaml`;
- inherits no Cloudflare account credentials or named-tunnel configuration;
- has bounded stdout/stderr retention while the hostname is discovered, then
  continuously drains both streams without retaining them; and
- is accepted only if exactly one valid single-label
  `*.trycloudflare.com` HTTPS hostname is emitted.

The isolated configuration environment is required because Cloudflare
documents that Quick Tunnels do not work when a `config.yaml` exists in the
default `.cloudflared` directory. It also prevents an operator's unrelated
named-tunnel configuration from changing this feature's behavior.

Cloudflare currently documents Quick Tunnels as a testing facility with a
200-concurrent-request limit and no Server-Sent Events. The viewer uses neither
SSE nor anything close to that concurrency. Quick Tunnel availability still
has no product uptime guarantee; a stable hostname or stronger availability
would require a future named-tunnel design.

### 5. Public frame readiness

Hostname discovery proves only that `cloudflared` printed a URL. Readiness is a
separate bounded state:

1. Generate and register a one-time startup token associated with an immutable
   frame snapshot and its expected digest.
2. Request `https://<validated-hostname>/probe/<startup-token>` with redirects
   disabled and a strict deadline.
3. Retry only transient connection, DNS, Cloudflare 5xx, and origin-not-ready
   results with bounded backoff inside the session startup deadline. Revoke the
   prior token and register a fresh one-shot token and frame snapshot for every
   new HTTP attempt.
4. Require HTTP 200, `Content-Type: image/jpeg`, a bounded body, JPEG SOI/EOI
   markers, and the digest recorded for that attempt's immutable frame
   snapshot.
5. Cancel the body, revoke the startup token, and drain tunnel logs.
6. Only then create viewer grants, persist the session lease, and return the
   tokenized `/watch/` URL to Telegram.

The digest comparison proves that camera-derived bytes traversed FFmpeg, the
Unix socket, the local viewer, Cloudflare's edge, and the outbound tunnel back
to the worker's probe client. It does not expose the digest or startup token in
logs.

The readiness request must bypass any application HTTP proxy and must not
follow redirects. DNS and TLS remain provided by the platform HTTP client.
Readiness failure tears down the complete provisional session and produces no
user URL.

### 6. Active session and cleanup

The existing session constraints remain:

- one active live session;
- a maximum five-minute lifetime;
- a small configured viewer cap;
- independent random viewer grants;
- revocation on stop, expiry, or source removal; and
- no public hostname or token in ordinary logs.

Cleanup is ordered and idempotent:

1. revoke startup and viewer grants and close responses;
2. stop and verify the owned `cloudflared` process group;
3. close the loopback server;
4. stop or recover the exact FFmpeg systemd instance;
5. close and unlink the Unix socket; and
6. remove the session lease.

A tunnel process exit, RTSP producer exit, invalid lease, worker restart, or
startup timeout triggers the same cleanup path. PID identity and process-group
verification remain required so recovery never signals an unrelated process.

## Installation and Upgrade

The privileged RTSP installer is reduced to durable host setup:

1. Install or verify `ffmpeg` and `cloudflared` packages.
2. Create or verify the dedicated stream user, group, and restricted runtime
   directories.
3. Install the sandboxed FFmpeg template unit and the narrow authorization
   policy used to start, stop, and inspect only UUID-shaped instances.
4. Stop, disable, and remove legacy `homeworker-stream-net.service` and its
   helper/inspector files; remove only the product-owned nftables table if it
   exists.
5. Remove legacy `live-stream-policy.json`, summary, digest, and temporary
   artifacts owned by this feature.
6. Reload systemd and restart the worker when group membership or installed
   assets changed.
7. Run application readiness after restart under the worker's real identity.

The privileged phase may run `ffmpeg -version` and `cloudflared version` only
as simple binary/package checks. It does not open a tunnel, run `tunnel diag`,
or switch to the worker UID. Application readiness checks that the worker can
execute both required binaries and that the runtime directories and unit assets
match expected ownership and modes.

Package installation cannot prove future Cloudflare service availability.
Every requested live session proves that separately with the public frame
readiness gate.

Upgrade cleanup is tightly scoped to known product-owned paths and unit names.
It preserves:

- all camera and RTSP source rows;
- encrypted usernames and passwords;
- `RTSP_CREDENTIALS_KEY`;
- unrelated nftables tables and firewall rules;
- unrelated Cloudflare configuration; and
- application data and event history.

Install, upgrade, retry, and reinstall all converge on the same state. A
failure before durable host changes is `dependency-install-failed`; a failure
after mutation reports the exact incomplete asset and remains retryable.
`installed = false` always offers Retry install, even when an attention reason
is present.

## Error Model

The Camera application boundary maps infrastructure failures to a closed,
non-secret set:

- `rtsp-source-invalid`
- `rtsp-source-unreachable`
- `rtsp-authentication-failed`
- `rtsp-frame-timeout`
- `local-viewer-unavailable`
- `quick-tunnel-start-failed`
- `quick-tunnel-public-frame-failed`
- `live-stream-capacity-reached`
- `live-stream-expired`
- `live-stream-cleanup-required`

Telegram receives localized, actionable messages. Raw URLs with credentials,
viewer tokens, Cloudflare diagnostic output, child environments, and response
bodies are never included in user messages or normal logs. Root-only
installation logs may identify the failing component but must retain the same
credential redaction.

## Testing

### Unit tests

- URL and resolved-address validation accepts the supported private cases and
  rejects public, mixed, loopback, link-local, multicast, unspecified, and
  malformed cases.
- Quick Tunnel output parsing accepts one valid single-label hostname and
  rejects duplicates, other domains, paths, credentials, and oversized output.
- Startup tokens are one-shot, separately hashed, deadline-bound, and removed
  on every completion path.
- The public probe rejects redirects, wrong status or content type, oversized
  bodies, malformed JPEGs, and frame digest mismatches.
- Feature-state presentation offers Retry install for an uninstalled feature
  with an attention reason.

### Use-case tests

- No public URL is returned until first-frame, loopback, hostname, and public
  frame readiness all succeed in order.
- Each failure and cancellation point tears down the provisional tunnel,
  listener, FFmpeg unit, socket, grants, and lease.
- A late `cloudflared` start cannot resurrect an expired session.
- Viewer tokens remain per-user and revocable after startup-token removal.
- A terminal RTSP or tunnel failure closes active viewers and clears state.

### Infrastructure tests

- The cloudflared child receives an isolated configuration environment and no
  account credentials.
- Stdout and stderr are bounded during discovery and drained afterward.
- The loopback server listens only on `127.0.0.1`.
- The one-shot public frame route returns exactly the retained bounded JPEG.
- Systemd assets contain no dependency on the removed network-policy service.
- Installer harnesses contain no PAM user switch or `tunnel diag`, remove only
  known legacy assets, and remain idempotent.

CI uses fake child processes and local HTTP fixtures. It does not depend on a
real camera, Cloudflare, DNS, or Internet access.

### Raspberry Pi acceptance test

The release is not accepted until the following succeeds on the target Pi:

1. Start from the repaired or clean RTSP feature state and install RTSP.
2. Confirm install and post-restart readiness complete without PAM/runuser
   errors.
3. Configure or select a real private-LAN RTSP camera.
4. Request live view from Telegram.
5. Confirm the bot sends no link before the public frame probe succeeds.
6. Disable Wi-Fi on a phone and open the returned HTTPS link over mobile data.
7. Confirm the viewer receives changing camera frames, not only the HTML shell.
8. Confirm the Pi has no viewer listener on a LAN address and no inbound router
   port is open.
9. Stop the stream and confirm the tokenized URL stops serving the viewer.
10. Restart the worker and confirm no tunnel, FFmpeg instance, socket, or stale
    lease survives unexpectedly.

The acceptance record captures sanitized service status, timestamps, and the
random hostname only while the session is active. It never captures source
credentials or viewer/startup tokens.

## Acceptance Criteria

- A real RTSP camera can be viewed from outside the home LAN through the
  temporary HTTPS tunnel.
- The bot exposes no URL until an RTSP-derived JPEG has successfully traversed
  the public tunnel and passed bounded validation.
- Raw RTSP is never exposed to the Internet.
- The viewer origin binds only to loopback; remote access exists only through
  the outbound tunnel.
- `cloudflared` and FFmpeg run unprivileged, with FFmpeg retaining its dedicated
  systemd sandbox and resource limits.
- No installer path uses PAM, `runuser`, `setpriv`, or install-time tunnel
  diagnostics.
- No dynamic nftables policy service, policy summary/digest, or interface-bound
  policy artifact remains.
- Links remain random, tokenized, revocable, viewer-limited, and valid for no
  more than five minutes.
- Tunnel, viewer, FFmpeg, socket, grants, and lease are cleaned after every
  success, failure, cancellation, timeout, and restart path.
- Existing camera sources and encrypted credentials survive upgrade.
- A failed first install can always be retried from Telegram without manual DB
  repair.

## Trade-offs and Future Boundary

This design intentionally trades kernel-enforced per-destination egress policy
for a smaller, observable application boundary. That is appropriate for an
admin-managed worker and camera on the same trusted home LAN, while retaining
the controls that most directly protect credentials and Internet exposure.

Quick Tunnels solve NAT traversal with no account or permanent configuration,
but Cloudflare describes them as testing-only. If remote viewing later needs a
stable hostname, availability commitment, Cloudflare Access, or audit policy,
that is a separate named-tunnel design. It must not weaken the loopback origin,
per-user token, bounded session, or end-to-end frame readiness requirements
defined here.

## Documentation Reference

Current Cloudflare documentation used for this design:

- <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/>
- <https://developers.cloudflare.com/tunnel/setup/>
