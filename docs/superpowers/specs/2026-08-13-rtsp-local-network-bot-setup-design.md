# RTSP Local-Network Installation and Telegram Camera Setup — Design

## Status

Approved on 2026-08-13.

This design fixes the RTSP feature-install failure, makes RTSP camera setup
discoverable from the Camera dashboard, and hardens the complete Telegram
source-management workflow. It supersedes the operation-first RTSP source
menu described by the existing live-camera implementation where the two
designs differ.

## Problem

RTSP installation currently requires a non-empty `RTSP_ALLOWED_CIDRS` value,
but the setup wizard only writes `LIVE_STREAM_ENABLED`. The example environment
leaves `RTSP_ALLOWED_CIDRS` blank. Selecting or installing RTSP therefore fails
unless an operator edits the environment manually before installation.

The Telegram bot already has `/camera sources`, but Camera Dashboard has no
entry for it. The source workflow also assumes that the administrator knows an
existing camera name. An RTSP-only installation does not seed a camera row, so
the workflow cannot attach the entered address to anything.

The existing source menu exposes Add, Edit, Test, List, and Remove as equal
top-level operations. It hides current source state, gives no probe progress,
collapses configuration failures into generic copy, falls back to English in
Russian and Ukrainian, and treats credential-message deletion as an implicit
best effort rather than an explicit privacy contract.

## Goals

- Install RTSP without manual environment editing when the Pi has an active
  directly connected private LAN.
- Restrict camera traffic to the Pi's detected local networks. Do not infer or
  permit routed remote networks, public ranges, or arbitrary private ranges.
- Show an admin-only RTSP Sources action in Camera Dashboard only after RTSP is
  installed, enabled, restarted, and application-ready.
- Let an administrator create an RTSP camera by entering its display name and
  RTSP/RTSPS address through Telegram.
- Make RTSP Sources status-first, with contextual actions and actionable empty,
  loading, success, and failure states.
- Preserve the existing sandbox, encrypted credential storage, redaction, and
  feature-availability gates.
- Provide complete English, Russian, and Ukrainian behavior.

## Non-goals

- Cameras reachable only through a routed VLAN, VPN, public network, or custom
  manually entered CIDR.
- Automatic policy broadening when the Pi moves to another network.
- Persistent public streaming, custom domains, or a new Cloudflare model.
- Support for protocols other than RTSP and strict RTSPS.
- A general camera CRUD system outside RTSP source setup.
- Guaranteed removal of a credential message from Telegram. The bot can only
  attempt deletion and must state that limitation before input.

## Decisions

1. The installer derives policy from active, directly connected private routes.
   It does not use all RFC 1918 ranges as a broad default.
2. Telegram never modifies privileged network policy. It configures sources
   only inside the already-installed policy.
3. RTSP Sources appears only for administrators and only when RTSP readiness
   succeeds. `/camera sources` remains the direct expert entry point and applies
   the same role/readiness checks.
4. RTSP Sources opens on current status, not an operation picker.
5. Adding a new RTSP camera probes first and then atomically creates the camera,
   source metadata, and encrypted credential.
6. Test connection is non-mutating. Change address probes before replacing the
   saved source.
7. A newly created `type: rtsp` camera is removed with its source. Removing a
   source attached to a Motion camera leaves the Motion camera intact.

## Architecture

The change stays inside the existing Features, Camera, and Telegram bounded
contexts.

- The root-owned fixed feature routine discovers routes and installs the
  privileged runtime policy.
- Features owns RTSP installation outcomes and readiness. Its adapters inspect
  fixed artifacts; no Telegram handler shells out or reads privileged files.
- Camera owns camera registration, source probing, encrypted persistence,
  overview data, testing, replacement, stream teardown, and removal.
- Telegram is an interface adapter. It renders localized state and invokes
  application use cases through receipt-bound conversations.

No interface or application class imports a camera or feature infrastructure
adapter directly.

## Installer-Derived LAN Policy

### Route discovery

`iproute2` becomes a core installer prerequisite so route discovery is already
available before any RTSP-specific package mutation. Installer/helper upgrades
on existing deployments install and verify that prerequisite before exposing
runtime RTSP installation. The fixed root routine obtains JSON route and link
state through an absolute allowlisted `ip` executable.

An eligible network must satisfy all of these rules:

- The route is in the main table, is unicast, has `scope link`, has a concrete
  destination prefix, and has no gateway.
- Its device is active and is not `lo`.
- IPv4 is within `10.0.0.0/8`, `172.16.0.0/12`, or `192.168.0.0/16`; IPv6 is
  within unique-local `fc00::/7`.
- The network is not loopback, link-local, multicast, unspecified, or a default
  route.

The installer parses every prefix with strict network semantics, canonicalizes
it, removes duplicates, and sorts the result deterministically. Multiple active
Ethernet/Wi-Fi LANs are allowed. At least one eligible network is required.

No active eligible network fails before installing FFmpeg, nftables, polkit, or
cloudflared with the sanitized feature failure
`local-network-unavailable`.

### Durable artifacts

From one canonical subnet list, the installer prepares:

- `RTSP_ALLOWED_CIDRS=<canonical comma-separated list>` in the private worker
  environment;
- `/etc/home-worker/live-stream-policy.json`, retaining mode `0600` and root
  ownership;
- a root-owned, world-readable non-secret digest artifact containing the digest
  of the canonical subnet list; and
- `RTSP_POLICY_DIGEST=<digest>` in the private worker environment.

The digest lets application readiness detect environment/policy drift without
granting the worker read access to the privileged policy. The root helper also
verifies that the policy content was generated from that exact canonical list.

The environment update uses the existing no-follow, single-link, owner, and
mode checks. It replaces any previous `RTSP_ALLOWED_CIDRS` and policy digest
with the freshly detected local networks, preserves the credential key when it
is valid and non-empty, generates the key only when absent, and preserves all
unrelated settings.

Every output is written to a private file, flushed, validated, and atomically
renamed. The two-file operation cannot be globally atomic; its commit order is
policy, digest, then environment. A crash may temporarily create disagreement,
but readiness fails closed and an idempotent installer retry reconciles all
artifacts.

### Installation and restart outcome

The privileged helper distinguishes these sanitized RTSP failures from an
ordinary package failure:

- `local-network-unavailable`
- `network-policy-generation-failed`
- `dependency-install-failed`
- `privileged-verification-failed`

The result schema, domain failure union, persistence, and locale catalogs are
extended together. Raw route output and package diagnostics remain in the root
journal and are never delivered through Telegram.

RTSP installation retains supervisor restart scope because the worker must
receive `homeworker-stream` group membership and reload the installed policy.
Only after recovery and application readiness succeed does the feature become
installed and enabled.

### Readiness

RTSP readiness continues to verify FFmpeg, cloudflared, root-owned runtime
artifacts, runtime directory ownership/modes, the active network helper, and
worker group membership. It additionally:

1. Parses and canonicalizes the worker-visible `RTSP_ALLOWED_CIDRS`.
2. Computes its digest and compares it to both `RTSP_POLICY_DIGEST` and the
   fixed non-secret digest artifact.
3. Rejects an empty, malformed, broad, public, or inconsistent policy.

Readiness does not automatically replace policy after a network change. The old
policy keeps failing closed. The source UI reports that the RTSP feature must
be reinstalled on the Pi's new local network.

## Camera Application Model

### Published operations

Camera exposes focused use cases for:

- obtaining the RTSP source overview and redacted installed-policy summary;
- creating a new RTSP camera and source;
- attaching a source to an existing enabled camera;
- testing an existing source without persistence;
- replacing an existing source after a successful probe;
- removing an RTSP-created camera or detaching a source from another camera;
  and
- stopping active RTSP work before replacement or removal.

The existing media read port remains read-only. A camera-owned write port
publishes the narrow atomic registration/removal operations needed here. The
Drizzle adapter may implement both read and write ports, but consumers depend
on the appropriate port.

### Create flow

For a new RTSP camera:

1. Recheck RTSP availability and the process-local start gate.
2. Validate and normalize a unique display name.
3. Generate a stable opaque camera ID and construct a candidate `type: rtsp`,
   enabled camera without persisting it.
4. Parse the URL, resolve its host, enforce the installed CIDRs, and run the
   bounded restricted probe.
5. Encrypt the validated credential payload.
6. Recheck RTSP availability and the start gate.
7. In one SQLite transaction, insert the camera, source metadata, and credential.

If probing, encryption, availability, uniqueness, or persistence fails, no row
is created. Database uniqueness remains the final authority for concurrent
same-name attempts.

Attaching a source to an existing camera uses a camera picker and the camera's
existing ID. It probes and saves only the source/credential transaction.

### Test and replacement

Test connection loads the source through the credential port, probes the exact
saved settings, and returns a sanitized outcome. It does not update source
metadata, credentials, readiness, or timestamps.

Change address keeps the current source active while validating and probing the
candidate. After a successful probe it stops an active stream for that source,
encrypts the new credential, and atomically replaces metadata and credential.
A failed replacement leaves the old source untouched and usable.

### Removal

Removal always requires a confirmation containing the camera display name and
stops active work first.

- For a camera whose type is `rtsp`, one transaction removes live-source rows,
  credential rows, and the camera row.
- For any other camera type, the transaction removes only RTSP source and
  credential rows.

No plaintext credential is loaded for removal.

## Telegram Experience

### Camera Dashboard

Camera Dashboard retains Live as its primary camera action. When the current
user is an administrator and `FeatureAvailabilityPort` reports RTSP ready, it
adds a secondary localized `📡 RTSP Sources` button. The callback is
`cam:<receipt-id>:src`; it is validated before delegating to the existing
camera-source interface boundary.

Non-admin users and non-ready RTSP states do not receive the button. Direct
`/camera sources` remains available to administrators and explains the current
feature state if invoked while unavailable.

### Status-first Sources screen

The landing message contains:

- the title `RTSP Cameras`;
- `Local network only` plus redacted interface/subnet summaries;
- one line/button per configured source, using a localized operational state;
- `Add RTSP camera`; and
- Back and Home.

Persisted overview states use user-facing terms such as Configured and verified,
Credentials required, Not ready, and Needs attention. Transient test/setup
results may additionally say Blocked by local-network policy, Authentication
failed, or another categorized failure without persisting the test. Camera IDs,
credentials, and raw child diagnostics are absent. The list is bounded and
paginated before Telegram keyboard size becomes unwieldy.

An empty state briefly explains that the camera must be on the Pi's local
network and presents one primary `Add first camera` action. It does not present
Edit, Test, List, or Remove.

Selecting a source shows its display name, redacted host, status, and the
contextual actions Test connection, Change address, Details, and the correctly
named removal action. Details contains transport/profile and the redacted
policy relationship, not credentials.

### Add flow

The first decision is `Create RTSP camera` or `Attach to existing camera` when
an eligible existing camera is available. With no existing cameras, creation
starts directly.

Creation asks for a unique display name through ForceReply. The state records
the exact prompt message ID, receipt, user, private chat, and ten-minute expiry.
Only a reply to that prompt advances the flow.

Before URL input, the bot states:

- accepted schemes are RTSP and strict RTSPS;
- the host must resolve inside the displayed local networks;
- the URL may contain camera credentials;
- Telegram is not a secret channel;
- the bot will attempt to delete the reply but cannot guarantee deletion; and
- the prompt expires in ten minutes.

The URL prompt is another ForceReply bound to its exact message ID and receipt.
On valid input, the bot immediately sends `Testing connection…`, marks the
workflow running, and invokes the create/attach use case.

The input message is deleted in `finally` for success, validation failure,
probe failure, role change, and feature change. If deletion fails, the bot
identifies the exact reply by message context without repeating its text and
asks the administrator to delete it manually.

The handler retains bounded non-secret expired-prompt tombstones long enough to
recognize a late reply to a known credential prompt. Such a reply is not
processed; deletion is attempted and the bot offers `Start again`. Arbitrary
RTSP-looking messages that are not replies to a known prompt are not claimed.

### Error recovery

Typed errors map at the Telegram boundary to these safe categories:

- invalid RTSP/RTSPS address;
- address outside the installed local-network policy;
- camera name already exists;
- host not found or unreachable;
- authentication rejected;
- TLS verification failed;
- unsupported stream;
- probe timed out;
- RTSP feature changed or became unavailable; and
- policy is stale after a Pi network change.

An error retains only non-secret context such as the proposed display name or
selected camera. It offers the applicable Retry, Change address, Back, or
Reinstall RTSP guidance. No URL, username, password, token, resolved hostname,
raw route output, child stderr, or nested exception text appears in Telegram,
application logs, callbacks, or persisted workflow state.

### Localization

`camera.sources` becomes mandatory in `LocaleCatalog`. English, Russian, and
Ukrainian implement identical keys for dashboard entry, overview, policy
summary, empty state, progress, prompts, privacy warning, confirmation,
categorized errors, recovery actions, status labels, and expiry.

Action grammar uses closed semantic keys rather than interpolated English words.
Cancel buttons are authoritative; localized typed cancel synonyms are accepted
only while an exact text prompt is active.

## Security Properties

- Telegram cannot broaden the privileged network allowlist.
- The installed policy contains only active directly connected private networks.
- Every DNS answer must remain inside the installed policy before probing and
  before streaming; the existing ephemeral UID-scoped egress lease remains
  authoritative.
- RTSP credentials remain encrypted at rest and absent from config export.
- Plaintext exists only in the bounded configure/test/runtime path and is never
  stored in workflow state or camera rows.
- Prompt callbacks and text are bound to the exact user, private chat, receipt,
  and prompt message.
- Feature availability and admin role are rechecked before probing and before
  persistence.
- Active streams stop before replacement or removal.
- A network change never automatically widens access.

## Verification

### Installer and readiness

Tests cover one Wi-Fi/Ethernet subnet, multiple direct private subnets,
deterministic canonical ordering, and rejection of public, loopback, link-local,
multicast, unspecified, default, inactive-interface, and gateway-routed entries.
No eligible network must fail before any RTSP-specific package installation.

Environment tests prove owner/mode/no-follow enforcement, key preservation,
replacement of stale CIDRs, unrelated-setting preservation, digest parity,
interrupted replacement, and idempotent recovery. Privileged and application
readiness tests cover every artifact, service, group, directory, and policy
mismatch.

### Application and persistence

Use-case and SQLite integration tests prove:

- successful probe creates camera, source, and encrypted credential atomically;
- probe failure creates no rows;
- duplicate camera names fail safely, including concurrent attempts;
- attaching to an existing camera does not replace the camera row;
- Test connection performs no writes;
- failed replacement preserves the old source and credential;
- successful replacement stops active work before its atomic commit;
- RTSP-camera removal deletes camera/source/credential together;
- Motion-camera detachment preserves the camera; and
- feature/role changes prevent the next effect.

### Telegram and locales

Handler tests cover the full admin/readiness visibility matrix, direct-command
fallback, empty/populated/paginated overviews, exact ForceReply and receipt
binding, prompt expiry/tombstones, deletion on every terminal path, deletion
failure copy, progress acknowledgement, categorized errors, retry/back/home,
removal confirmation, stale callbacks, localized typed cancellation, private
chat enforcement, and the 64-byte callback limit.

Catalog parity tests require all source keys in English, Russian, and Ukrainian
and reject English fallback for this workflow.

### Target-Pi acceptance

On a Pi connected to its normal LAN:

1. Install RTSP through Feature Management without editing `.env`.
2. Confirm detected CIDRs match only active directly connected private LANs.
3. Confirm supervisor restart and readiness make RTSP Sources visible to an
   administrator and hidden from a normal user.
4. Create a new RTSP camera through Camera Dashboard and open a live view.
5. Confirm a source outside the installed LAN is rejected without an egress rule.
6. Exercise bad credentials, timeout, edit, non-mutating test, and both removal
   semantics.
7. Change or simulate policy drift and confirm fail-closed guidance.
8. Scan application logs, root journal excerpts exposed to the app, Telegram
   messages, database rows, exports, and callbacks for credential leakage.

## Acceptance Criteria

- A clean RTSP installation succeeds on a Pi with an active directly connected
  private LAN and no preconfigured `RTSP_ALLOWED_CIDRS`.
- Installation fails early and clearly when no eligible LAN exists.
- Installed policy permits only detected direct private subnets.
- An administrator can create an RTSP camera and set its address entirely
  through Camera Dashboard after RTSP becomes ready.
- Failed creation leaves no camera/source/credential rows; failed replacement
  preserves the working source.
- Source management is status-first, localized, receipt/prompt-bound, and
  recoverable without re-entering non-secret context.
- Test connection does not mutate persisted configuration.
- Credentials never appear in logs, callbacks, exports, or bot output, and the
  bot explicitly treats Telegram deletion as best effort.
- Normal users never see or invoke RTSP source-management effects.
