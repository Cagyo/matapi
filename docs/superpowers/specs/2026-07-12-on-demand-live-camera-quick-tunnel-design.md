# On-Demand Live Camera Viewing via Quick Tunnel — Design

## Status

Implemented and target-Pi accepted with documented verification deviations for
Motion/MJPEG and the tested RTSP matrix.
Public-CA RTSPS remains best effort, and self-signed RTSPS is unsupported. See
`docs/compatibility/live-camera-rtsp.md` for measured evidence and remaining
manual-browser coverage. This remains an explicitly experimental, no-domain
live-view feature. It does not claim production reliability, Cloudflare Access
authentication, Cloudflare ToS approval, or zero internet exposure.

## Purpose and scope

Registered Telegram users can open a live view for one configured camera. The worker starts the public path only on demand and tears it down after a strict, non-renewable five-minute session. At all other times, neither cloudflared nor video conversion runs.

The feature supports two independently configured source families:

- Motion MJPEG, supplied by the locally bound Motion daemon stream.
- RTSP, an optional, separately installed and enabled compatibility feature.

The design intentionally uses a Cloudflare Quick Tunnel because no custom domain is available. Cloudflare documents Quick Tunnels as development/testing only, without an uptime guarantee; the feature must be presented as experimental. A Quick Tunnel is a temporary public bearer endpoint, not an identity provider.

## Non-goals

- A persistent public camera endpoint, domain name, Cloudflare Access, or Cloudflare API/account setup.
- A custom Telegram Mini App or a full web UI.
- Unlimited viewers, multiple concurrent camera sessions, recording, or audio.
- A guarantee that a link holder is the Telegram user to whom the link was issued.

## Capability and installation model

The installer offers an explicit Experimental live streaming (Quick Tunnel) option whenever Motion or RTSP is selected. It installs and validates the architecture-appropriate cloudflared binary, but never installs a cloudflared system service or stores a Cloudflare token, account credential, domain, or tunnel configuration.

The RTSP installer additionally installs FFmpeg. The rtsp feature is independently represented in the feature catalogue and can be enabled or disabled through the existing admin feature controls. Motion remains its own feature. Live viewing is available only when the Quick Tunnel capability is installed and one of these sources is eligible:

1. Motion is installed and enabled with a configured local stream route.
2. RTSP is installed, enabled, and has a configured live source.

The installer performs a Quick Tunnel preflight. In addition to validating the binary, it runs cloudflared's tunnel connectivity diagnostic from the Pi and records whether DNS plus outbound TCP or UDP port 7844 are available. If an existing cloudflared configuration prevents Quick Tunnels from starting, or connectivity is unavailable, it marks experimental live streaming unavailable rather than editing or deleting a user-owned Cloudflare configuration. Package upgrades use the same package-management path as the initial installation.

Feature state is asymmetric by design. Enabling RTSP takes effect after the normal worker restart; disabling RTSP immediately cancels an active RTSP session, rejects new RTSP starts, and then completes the normal restart-based module unload. A composition-root lifecycle hook owns this exception so the generic features context does not import camera infrastructure.

## Architecture

All feature code lives in the camera bounded context. Telegram remains an interface adapter and never spawns processes or reads camera credentials.

### Application services and ports

- LiveStreamSessionService is the single owner of the live-session state machine, session lease, viewer tokens, cancellation, and cleanup.
- OpenLiveStreamUseCase resolves a requested camera and asks the session service to start or join a session.
- StopLiveStreamUseCase stops the current session at the request of any registered user.
- A camera-owned live-source port resolves a Motion source or the decrypted RTSP source. It returns typed, sanitized metadata to callers.
- A camera-owned tunnel port starts and stops a Quick Tunnel, returning only a validated trycloudflare.com hostname.
- A camera-owned stream-gateway port runs the loopback proxy and, for RTSP, owns the single FFmpeg converter.
- A camera-owned stream-sandbox port starts the FFmpeg converter as a restricted system service and exposes only its lifecycle and sanitized health state to the worker.
- A credential port owns encrypted RTSP credential persistence and recovery.

The production adapters are a loopback HTTP stream gateway, CloudflaredQuickTunnelAdapter, a sandboxed FFmpeg RTSP adapter, and a Drizzle-backed credential adapter. Stub adapters make session and handler tests deterministic without a camera, cloudflared, or FFmpeg.

### State machine

idle → starting → ready → stopping → idle is serialized: every start, stop, source edit, user revocation, and expiry operation goes through one coordinator. Starting is cancellable. A stop during startup prevents a later hostname or watch link from being sent.

Exactly one source session exists globally. A request for the active camera receives a new viewer token for the remaining session time. A request for a different camera stops the active session completely before starting the new one.

The session starts a loopback-only proxy on a random port. cloudflared points only at this port; it never points at the Nest HTTP application, Motion hook port, or another localhost service.

## Access and session lifecycle

/camera live [camera] and a Motion-alert Watch live callback are available to registered users. The callback contains no stream token; the handler checks the caller's current registration before it invokes the same use case as the command.

When cloudflared reports a validated public hostname, the strict five-minute lease begins. It cannot be renewed. The running process uses a monotonic deadline; boot recovery never reconstructs or extends a live session from wall-clock time and instead fails closed by stopping the recorded group. A later authorized request for the same camera receives a separate, opaque viewer token only for the remaining time. The worker has a short, separate startup timeout; a tunnel that does not obtain a hostname in time is stopped without sending a link.

The ordinary Telegram URL button opens a tokenized watch path. The proxy may exchange the token for a short-lived Secure, HttpOnly cookie and redirect to a clean minimal page, but the original link remains usable until expiry so a prefetch or browser restart cannot consume it. The page contains only the live image plus an expiry fallback, no third-party assets. It sends no-store, no-referrer, and restrictive content-security headers.

A viewer token contains at least 256 bits from a cryptographic random source. The session retains only a token hash and uses constant-time verification. A token is associated with a Telegram user and is rechecked when a new browser connection opens. This enables revocation and auditing but does not turn the link into proof of browser identity: anyone holding the complete link can watch until it expires. User demotion or removal immediately revokes that user's tokens and closes their active responses.

At most two stream responses are active globally and only one is active for a given token. Slow clients are disconnected rather than buffered. The session lease persists the chat/message references needed to delete issued watch-link messages. At expiry the proxy renders the simple Stream ended state, invalidates all tokens and cookies, removes those messages where Telegram permits, terminates the tunnel/proxy/converter process group, and clears the runtime lease. If a restart prevents message cleanup, the invalidated link remains visible but cannot reopen the stream.

Every registered user can run /camera stop_stream. The action is audited, rate-limited per user, ends the session immediately, and sends a sanitized admin notification. A camera-source add, edit, or removal also stops an active session for that source before any configuration mutation.

## Crash recovery and resource control

The in-memory timer is not the sole cleanup mechanism. The session writes a runtime lease containing a random session nonce, process-group identity, and process-start identity. Normal shutdown cleans up the whole owned process group. On boot, the worker verifies every recorded identity before reaping a stale group; uncertainty causes an admin alert rather than a broad pkill or a potentially unrelated process termination.

Resource limits are measured across the Node worker, cloudflared, and FFmpeg process tree, not solely through PM2's Node-process memory threshold. Exceeding configured CPU, memory, startup, or frame-delivery limits stops the session safely. cloudflared's loopback metrics listener is treated as an owned child resource and checked during cleanup. Process stdout/stderr is bounded and parsed only into sanitized error categories; neither raw source URLs nor tokens may reach logs or exception chains.

## Sources

### Motion MJPEG

Motion sources are derived from installer-owned loopback configuration, never entered by a Telegram user. Multi-camera source resolution is explicit: Motion can expose a per-camera path on one port or use separate ports, so a camera ID must map to the documented Motion stream route rather than assuming every camera is 127.0.0.1:8081.

### RTSP compatibility feature

RTSP supports rtsp:// and strict rtsps://, hostnames or IPs, H.264/H.265, and
TCP or UDP. Public-CA RTSPS is best effort until a behavioral fixture is
accepted. Self-signed RTSPS is not exposed because target FFmpeg cannot enforce
a configured certificate fingerprint. Each source exposes these admin-visible
settings:

- transport: auto, tcp, or udp;
- TLS verification: strict CA and hostname verification;
- output profile: eco, balanced, or quality;
- optional low-resolution substream URL.

The default is TCP, strict certificate verification, eco, one converter, and
two viewer responses. Trust-any-certificate behavior is forbidden. Setup probes
the exact runtime configuration, detects codec/resolution/transport, and saves
only after a successful bounded sample stream. The same protocol allowlist,
network timeouts, video-only selection, port range, and resource profile are
used by the probe and live converter. An admin can relax supported compatibility
settings only after seeing an explicit warning.

Hostnames are permitted only if all resolved addresses are within installer-configured ranges. Before each session, the worker resolves the selected source and installs an ephemeral UID-scoped egress rule that allows the stream service to reach only the resolved addresses, configured camera ports, and required TCP/UDP transport. A runtime resolution mismatch rejects the stream. This contains time-of-check/time-of-use resolution changes; a legitimate camera address change requires a new probe. H.265 and high-resolution streams are best-effort: the session stops if measured resource or delivery limits are exceeded. The compatibility matrix labels combinations as tested, best-effort, or unsupported.

### FFmpeg sandbox

The FFmpeg converter is not a child with the worker's authority. The installer
creates a dedicated stream-service account and an installer-owned systemd
service template that starts one instance per session with a five-minute runtime
maximum, CPU and memory limits, no new privileges, a private temporary
directory, protected home and system paths, explicit inaccessibility for the
worker environment and data directory, and an address-family restriction. The
stream service cannot read the worker environment, Telegram token, database, or
RTSP encryption key.

The stream service receives only the selected source for the current session and
has egress limited to the ephemeral camera-address rule above. A root-owned
installer helper accepts only a session ID plus previously validated resolved
addresses and updates that rule; it never accepts a raw RTSP URL. Its local
interface authenticates the worker service identity, accepts addresses only
inside installer-configured camera ranges, applies a bounded rule count and
lease, and has no general command-execution operation. cloudflared runs outside
this sandbox and retains only outbound Cloudflare connectivity on port 7844.
The runner passes the source through a sealed memory file, so the inspectable
FFmpeg argv contains no URL or credential. Root and the stream-service identity
remain inside the residual runtime trust boundary. Process arguments and raw
stderr are never logged.

Administrators configure RTSP sources through the admin-only /camera sources conversation: add, edit, test, list, and remove. The bot deletes a credential-bearing incoming message immediately after processing and reports a deletion failure without echoing the value. This reduces chat-history exposure but is not confidential credential transport; bots cannot use Telegram Secret Chats.

RTSP source metadata is typed and stored separately from camera enablement. An imported source with no credential is not ready for live view, but does not disable the camera's snapshots, events, or other camera behavior.

### Credential handling

Non-secret source metadata is stored with the camera. The credential-bearing RTSP URL is stored separately as an authenticated-encrypted payload with a fresh nonce and key version. Its installation-generated key is stored in a mode-0600 environment file, outside SQLite backups. The key has no automatic export or recovery artifact: a restore without the original key requires RTSP credentials to be re-entered. Key rotation decrypts and re-encrypts every stored credential before retiring the old version; a failed rotation leaves the old version active. Normal config export never contains the key or plaintext credential.

Status, alerts, exports, imports, and logs reveal only source type and a redacted host. A dedicated camera-source export/import schema carries only non-secret source metadata; it does not reuse the existing generic camera config snapshot. Import marks a source not-ready when its credential is absent, without disabling unrelated camera behavior. The source's dedicated camera account must be read-only. FFmpeg requires a source URL while it runs, so encryption at rest does not eliminate runtime process-argument exposure; the deployment must protect local process visibility and never log FFmpeg command lines or raw stderr.

## Errors and user experience

Users receive generic localized outcomes. Administrators receive a sanitized category only: source unavailable, camera rejected credentials, unsupported stream, resource limit, tunnel unavailable, session ended, or configuration requires credentials. Raw hostnames, URLs, credentials, tokens, child-process text, and stack traces are never user-facing.

The dashboard and alert action label the feature Experimental live view — expires in 5 minutes. They do not claim persistent availability, user identity enforcement, zero attack surface, or Cloudflare production support.

## Verification

Unit tests cover the session state machine, non-renewable expiry, concurrent start/stop/switch races, cancellation during startup, token issuance, revocation, viewer limits, role checks, stop auditing, and source-edit teardown.

Integration tests use fake cloudflared and FFmpeg processes plus local MJPEG and RTSP fixtures. They verify token/cookie access, clean redirects, expiry fallback, bounded client buffering, process-group cleanup, stale-lease identity checks, source validation, feature gating, encrypted credential persistence, dedicated source export/import, backup/restore behavior, and negative secret-leakage cases across stderr, exception chains, logs, and Telegram message-deletion failures. Sandbox tests prove the stream service cannot read worker secrets or the database and that ordinary local users cannot inspect its arguments; they document root and stream-account argv visibility as residual risk.

Manual target-Pi acceptance verifies the published compatibility matrix on Telegram's iOS and Android browsers. It records whole-process-tree CPU and memory behavior for representative H.264/H.265, TCP/UDP, certificate, and resolution combinations. It also runs a real Quick Tunnel MJPEG session, rather than relying only on a mock tunnel, to validate external stream behavior. Unsupported or resource-exceeding combinations are reported rather than retried indefinitely.

## External constraints

- [Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/): development/testing-only, no SLA, anonymous random hostname, and a documented concurrent-request limit.
- [Cloudflare local configuration](https://developers.cloudflare.com/tunnel/advanced/local-management/configuration-file/): cloudflared can discover configuration from default locations; Quick Tunnel availability must be preflighted.
- [Cloudflare connectivity checks](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/troubleshoot-tunnels/connectivity-prechecks/): tunnel operation needs outbound TCP or UDP connectivity on port 7844 and should be diagnosed from the Pi.
- [Motion stream configuration](https://motion-project.github.io/4.2.2/motion_config.html): multi-camera streams can use camera-specific paths or ports and must remain localhost-bound.
- [FFmpeg protocols](https://ffmpeg.org/ffmpeg-protocols.html): protocols are broadly enabled by default, so the runtime must use explicit allowlists and I/O limits.
- [Telegram Bot API](https://core.telegram.org/bots/api): bots can delete incoming private-chat messages within the API's constraints; deletion does not provide end-to-end secret transport.

## Implementation slices

1. Add the experimental Quick Tunnel capability, camera session state machine, loopback MJPEG proxy, per-user viewer tokens, strict lease, cleanup/recovery, Telegram live/stop actions, and Motion-source mapping.
2. Add the separate RTSP feature, typed live-source schema, encrypted credential storage and key rotation, dedicated camera-source export/import, admin configuration flow, compatibility modes, sandboxed FFmpeg converter, UID-scoped egress helper, and source probe.
3. Run the target-Pi compatibility matrix and publish the supported source combinations before enabling RTSP for ordinary users.
