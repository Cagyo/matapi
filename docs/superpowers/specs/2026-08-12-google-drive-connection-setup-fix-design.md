# Google Drive Connection Setup Fix

> **Date:** 2026-08-12
> **Status:** approved design
> **Scope:** repair Google limited-input device authorization, add detailed
> Telegram setup instructions, and classify setup failures without exposing
> credential or provider data

## 1. Goal

An administrator who chooses **Connect Drive** from Storage & backup or runs
`/gdrive connect` must receive the same complete Google Cloud setup guide and
must be able to connect with a downloaded OAuth client of type **TVs and
Limited Input devices**.

The current flow rejects a valid Google device-code response because Google
returns `verification_url` while the adapter reads `verification_uri`. It also
reports every document, Google, and network failure as invalid JSON. This
change fixes the protocol mismatch and gives each failure a safe, actionable,
localized reply.

## 2. Confirmed defects

1. `GoogleDeviceAuthorizationAdapter.requestCode()` reads
   `verification_uri`. Google's limited-input device protocol returns
   `verification_url`.
2. The adapter reads only `error` from failed device-code responses. Google
   documents device-code quota exhaustion as HTTP 403 with
   `error_code: "rate_limit_exceeded"`.
3. `GdriveHandler.handleDocument()` maps all failures to the localized
   `invalidClient` reply, including valid Google responses, provider rejection,
   policy failures, timeouts, and transport errors.
4. The ten-minute `PendingDriveConnection` begins before an administrator
   performs the Google Cloud setup. A normal first-time setup can therefore
   expire before the JSON exists.
5. The existing prompt does not explain that Web and Desktop clients are
   incompatible with Google's device endpoint or that an External app left in
   Testing receives seven-day authorizations and refresh tokens.

## 3. Approved decisions

- Use one shared flow for the Storage menu and `/gdrive connect`.
- Show fully detailed instructions in English, Ukrainian, and Russian.
- Start with a secret-free preparation phase. Create the ten-minute pending
  generation only when a matching JSON document is uploaded.
- After Google returns a challenge, bound authorization by the earlier of the
  ten-minute pending deadline and Google's returned challenge expiry. Polling,
  confirmation, cancellation, and staged-secret cleanup use that same effective
  deadline; no continuation extends it.
- Only an OAuth client created with the exact Google application type **TVs and
  Limited Input devices** can complete setup. Reject an explicit Web envelope
  locally. Treat Desktop and limited-input `installed` documents that are not
  safely distinguishable as credentials for Google to validate; map Google's
  `invalid_client` without exposing its response.
- Parse Google's documented `verification_url` and preserve the case-sensitive
  `user_code` without modification.
- Recognize both `error` and the documented device-code `error_code` field.
- Classify failures with typed errors at their owning boundaries. Do not infer
  failure type from exception-message text.
- Preserve an existing active Drive connection after every failed replacement.
- Delete every credential document associated with an active preparation on a
  best-effort basis, including rejected documents.
- Use the existing durable `workflow-return` receipt for pre-upload Cancel,
  replacement, Home/origin return, and terminal completion. Exact in-memory
  cleanup is registered through `WorkflowDraftRegistry`.
- Allow multiple administrators to prepare independently, but preserve the
  database invariant of one installation-wide staged/authorizing generation.
  A competing upload receives a typed, retryable busy response and keeps its
  preparation.
- Keep ephemeral Drive setup state in one injectable Telegram-side registry so
  the handler, workflow cancellation, demotion, and background authorization
  outcomes perform the same receipt- and generation-fenced transitions.
- Keep pre-upload preparation in process memory. A restart intentionally
  clears it and asks the administrator to start again.
- Keep the implementation within the existing `archive` and `telegram`
  boundaries; no new bounded context or database migration is needed.

## 4. User flow

### 4.1 Entry

Both entry points call `GdriveHandler.handleConnect()` with a durable
`drive-setup` receipt:

- Storage & backup → Connect Drive; and
- `/gdrive connect` in a private administrator chat.

The handler reauthorizes the current administrator. A menu launch uses the
supplied receipt. A direct `/gdrive connect` launch first calls
`WorkflowEntryCoordinator.begin()` with the natural `admin-storage` parent.
Receipt replacement atomically supersedes the administrator's older workflow;
the coordinator then invokes the registered exact Drive draft canceller, which
removes only the replaced preparation or cancels only its staged authorizing
generation. The handler records a secret-free preparation binding and sends the
detailed guide with two controls:

- **Open Google Cloud Console** — URL button; and
- **Cancel** — `wr:<receipt-id>:o`, the existing receipt-bound origin-return
  callback. It contains no generation ID because no generation exists yet.

The preparation binding contains only administrator ID, private chat ID,
workflow receipt ID, and expiry. It contains no client ID, client secret,
generation ID, device code, token, or provider URL. If guide delivery fails,
the registry removes that exact preparation and leaves the durable receipt to
the normal resumable workflow-recovery path.

### 4.2 Preparation lifetime

Preparation may remain open for the existing 24-hour workflow-return lifetime.
The ten-minute `PendingDriveConnection` does not exist yet. Waiting while the
administrator configures Google Cloud therefore cannot expire the later
device-flow invitation.

Starting Connect Drive again replaces the same administrator's preparation or
cancels their exact staged authorizing generation before starting the new
preparation. A different administrator cannot submit a document or callback
against it. A worker restart drops the in-memory preparation and requires
Connect Drive to be started again.

Preparations for different administrators may coexist because they contain no
secrets. Only one of them may enter `authorizing` at a time. If another staged
generation already owns the database's installation-wide staged slot, the
upload maps to `DriveSetupBusyError`, discards the newly allocated in-memory
pending generation, returns the exact state to `preparing`, and tells the
administrator to retry the same document later. It never cancels the other
administrator's setup.

### 4.3 Document submission

Uploading a document acts as Continue; no Ready button is introduced. Before
authorization or reading, the handler first snapshots whether the raw sender,
private chat, and current receipt identify an exact Drive preparation. That
association snapshot exists only to decide exact cleanup and message deletion;
it grants no authority. The handler then rechecks:

- private chat;
- current administrator role;
- exact user/chat preparation binding;
- current workflow receipt; and
- preparation expiry.

Only after those checks does `BeginDriveConnectionUseCase` create the actual
ten-minute pending generation. Before the first document read, the registry
atomically changes that exact `preparing` state to `authorizing` and attaches a
local operation `AbortController`. The handler uses
`AbortSignal.any([stateSignal, transportTimeout])` while it downloads, parses,
validates, stages, and submits the client to Google. Demotion, receipt
replacement, Cancel, or expiry can therefore stop in-flight setup work before
it stages or polls with stale authority.

`DriveSetupStateRegistry` keeps one explicit per-user/chat state union and uses
receipt- and generation-fenced compare-and-set transitions:

- `preparing` — receipt and preparation expiry, with no credentials; or
- `authorizing` — the freshly created `PendingDriveConnection`, its effective
  deadline once known, and the local operation controller used by initial work,
  authorization, and confirmation callbacks.

Document or initial-provider failure compare-and-sets `authorizing` back to
`preparing` when the preparation receipt is still current. Successfully
receiving a valid Google challenge records the effective deadline on the same
`authorizing` state; additional documents cannot start a second generation.
Cancel, replacement, demotion, and expiry remove the exact state, abort its
operation controller, and cancel/discard its staged generation. Terminal
success removes only the exact in-memory state after atomic activation has
consumed the staged row.

Background denial, provider failure, or expiry is also terminal for the exact
authorizing state. The authorization outcome adapter asks the registry to
remove that receipt/generation, completes the durable workflow through the
existing headless outcome path, delivers the localized terminal result, and
restores the authorized origin when it is still current. A stale outcome from a
cancelled or replaced generation cannot mutate newer state or complete a newer
receipt. Successfully exchanging tokens is not terminal: the state remains
`authorizing` until the administrator confirms the resolved account.

The message document is deletion-attempted in `finally` whenever the initial
association snapshot matched an active Drive preparation. This includes
forwarded, oversized, malformed, non-UTF-8, download-failed, and post-demotion
submissions. Wrong-user/chat messages are neither read nor deleted. If Telegram
deletion fails, the administrator receives the localized manual-deletion
warning. Failure to deliver that warning is logged without identifiers and
does not replace the original setup result or state transition.

### 4.4 Google authorization

For a valid client, the worker:

1. requests only `https://www.googleapis.com/auth/drive.file`;
2. obtains and validates Google's device-code response;
3. shows the returned verification URL and exact user code;
4. computes the effective authorization deadline as
   `min(pending.expiresAtMs, challenge.expiresAtMs)`;
5. polls at Google's returned interval until that effective deadline, including
   `slow_down` handling;
6. resolves the authorized account identity;
7. asks the administrator to confirm that account; and
8. atomically activates the new generation after folder verification.

The existing active generation remains authoritative until step 8 succeeds.
Confirmation rechecks the current administrator, exact receipt/generation,
current workflow, staged row, and effective deadline. Terminal success removes
the exact state, completes the durable receipt, delivers the success result,
and restores the authorized origin through the existing workflow coordinator.

## 5. First-message instructions

Each locale conveys the following English source content. Translations must
preserve the exact English Google application-type label **TVs and Limited
Input devices** so it can be matched in Google Console interfaces.

> ☁️ Connect Google Drive
>
> Home Worker needs an OAuth client created in a Google Cloud project you
> control. Do not upload a Web or Desktop client.
>
> 1. Open Google Cloud Console and sign in with the account that will own this
>    project.
> 2. Create a project dedicated to this Home Worker installation, or select an
>    existing dedicated project.
> 3. Open APIs & Services → Library, find Google Drive API, and press Enable.
> 4. Open Google Auth Platform → Branding. If setup has not started, press Get
>    started. Enter an app name such as “Home Worker,” select a support email,
>    add a contact email, accept the Google API Services User Data Policy, and
>    finish setup. Under Audience, choose External for a personal account or
>    access outside one Google Workspace organization. Choose Internal only
>    when the project belongs to your Workspace organization and the Drive
>    account is a member of that same organization.
> 5. Open Google Auth Platform → Data Access → Add or remove scopes. Add
>    `https://www.googleapis.com/auth/drive.file`, then save.
> 6. If you chose External, open Google Auth Platform → Audience and publish the
>    app so its status is In production. Do not leave an External app in
>    Testing: Google expires Testing authorizations and refresh tokens after
>    seven days. Internal apps do not use this External publishing step.
> 7. Open Google Auth Platform → Clients → Create client.
> 8. Set Application type to exactly “TVs and Limited Input devices.” Enter a
>    name such as “Home Worker device” and create it.
> 9. Download the client JSON. Do not use a Web application or Desktop app
>    JSON.
> 10. Return to this private chat and send the downloaded JSON using Telegram's
>     document/file attachment. Do not paste its contents, edit it, or forward
>     it from another chat.
>
> Keep the downloaded file private. After reading the Telegram document, the
> bot will try to delete that message. If Google shows an unverified-app
> warning, continue only when this is your own project and you recognize the
> requested `drive.file` permission. For an Internal app, use only an account in
> the same Workspace organization as the project.
>
> If setup is interrupted or the bot restarts, press Connect Drive again.

Each rendered localized guide must contain no more than 3,500 characters,
leaving margin below Telegram's 4,096-character `sendMessage` limit. The
Console is opened through the URL button, so the guide does not rely on a link
preview.

## 6. Component responsibilities

### 6.1 Telegram interface

`GdriveHandler` owns live role/binding checks, keyboard construction,
credential-message deletion, and typed error-to-locale mapping. It never
examines raw provider content or matches exception message strings.

`DriveSetupStateRegistry` owns the bounded in-memory `preparing | authorizing`
union and its exact receipt/generation compare-and-set transitions. It registers
as the `drive-setup` `WorkflowDraftCanceller`, cancels only an exact staged
generation through `CancelDriveConnectionUseCase`, aborts the exact local
operation controller before cleanup, and rejects stale outcomes.
On an accepted terminal transition it returns the exact receipt/generation to
the handler or outcome adapter, which completes the durable workflow through
`WorkflowEntryCoordinator`; the registry does not depend on that coordinator.
`GdriveHandler`, `DemoteHandler`, and
`TelegramDriveAuthorizationOutcomeAdapter` all use this same registry; none
maintains a second Drive setup map.

After `DemoteUserUseCase` commits a demotion, `DemoteHandler` asks the registry
to cancel the demoted user's exact Drive setup. A `preparing` state is simply
removed. An `authorizing` state cancels polling and discards its exact staged
generation. `CancelDriveConnectionUseCase` aborts the known generation before
its repository lookup/discard, so a database cleanup failure cannot leave
polling live. Such a failure is sanitized and the existing boot expiry remains
the backstop for the unusable staged row; it never rolls back the
already-authoritative role change or affects the active Drive generation.

`TelegramDriveClientDocumentAdapter` owns the declared-size and streaming
64-KiB limit, fatal UTF-8 decoding, and Telegram download failures. Its range
request asks for one byte beyond the accepted maximum, or validates the remote
total from `Content-Range`, so a range-respecting server cannot hide an
oversized file by returning an apparently complete 64-KiB prefix. It must not
log a file URL because Telegram download URLs contain the bot token.

### 6.2 Archive application

The installed-client parser owns JSON and credential-envelope validation. It
accepts surrounding JSON whitespace and one leading UTF-8 BOM. It requires
exactly one `installed` envelope with bounded, valid `client_id` and
`client_secret`, ignores inert unknown metadata for forward compatibility, and
returns only `clientId` and `clientSecret`. Uploaded endpoint, redirect,
certificate, origin, and unknown fields never control a worker request.

The parser explicitly classifies a `web` envelope as unsupported client type.
It does not claim to distinguish Desktop from limited-input clients using
undocumented downloaded metadata. An `installed` document may still be
rejected by Google if the client was deleted, disabled, or is not a **TVs and
Limited Input devices** client; that rejection receives the dedicated
client-rejected guidance.

The application use case stages credentials only after parsing succeeds. The
repository translates its installation-wide staged-slot conflict to
`DriveSetupBusyError`. If the initial Google request fails, the use case
discards that exact staged generation and leaves the previous active generation
untouched. Busy and every expected initial failure return the exact ephemeral
state to `preparing` when its durable receipt remains current.

Preparation, pending, effective-deadline, and confirmation-expiry decisions use
the injected `ClockPort`; no Drive setup deadline branch reads `Date.now()`
directly. This keeps the 24-hour preparation, ten-minute pending window, and
workflow receipt on one deterministic clock authority. Google protocol sleep
and challenge calculations receive an adapter clock backed by the same token in
the composition root.

### 6.3 Google infrastructure

`GoogleDeviceAuthorizationAdapter` owns protocol fields and provider error
mapping. On success it requires non-empty `device_code`, `user_code`,
`verification_url`, and positive `expires_in`. `interval` defaults to five
seconds when absent. `verification_url_complete` is optional and maps to null
when absent.

The adapter bounds every OAuth/discovery JSON body to 64 KiB before parsing.
`device_code` is 1–4,096 bytes. `user_code` is 1–64 printable US-ASCII
characters and is preserved byte-for-byte. `verification_url` is 1–2,048
printable US-ASCII characters, parses as an absolute HTTP or HTTPS URL, and has
no username or password component. The adapter does not hardcode its host or
modify it because Google documents the returned value as changeable.
`expires_in` and `interval` must be positive safe integers whose millisecond
conversion is safe. Oversized bodies, invalid bounds, malformed JSON, and
invalid successful fields raise `DriveProviderResponseError`.

The adapter accepts only the existing hardcoded/discovered allowlisted Google
endpoints and still rejects redirects. It never trusts endpoint values from
the uploaded client document.

On failure it checks the documented response discriminator appropriate to the
endpoint. Device-code HTTP 403 `error_code: "rate_limit_exceeded"` maps to
`DriveRateLimitedError`. Token HTTP 401 `error: "invalid_client"` and the same
recognized error from the device-code endpoint map to
`DriveOAuthClientRejectedError`. `admin_policy_enforced` and `org_internal` map
to `DrivePolicyBlockedError`; `access_denied` maps to
`DriveAuthorizationDeniedError`; `authorization_pending` and `slow_down` remain
polling control flow; `invalid_grant` and `expired_token` map to
`DriveReauthorizationRequiredError`; 429 maps to `DriveRateLimitedError`; and
5xx or transport timeout maps to `DriveTemporaryUnavailableError`. Caller
cancellation remains cancellation and is never presented as a provider
failure. Any other 4xx discriminator maps to `DriveTemporaryUnavailableError`
and logs only status plus a closed local code. Provider descriptions and
response bodies are discarded.

## 7. Typed failure contract

### 7.1 New setup-specific errors

Introduce narrowly scoped types rather than expanding the already broad
`DriveConfigurationError`:

- `DriveClientDocumentError`, with a closed reason union:
  - `download-failed`;
  - `too-large`;
  - `invalid-utf8`;
  - `malformed-json`;
  - `invalid-credentials`; and
  - `unsupported-client-type`.
- `DriveOAuthClientRejectedError` for Google `invalid_client`.
- `DriveSetupBusyError` when another administrator owns the single
  installation-wide staged slot.
- `DriveSetupExpiredError` for an expired preparation or pending invitation.
- `DriveProviderResponseError` for a successful Google response that violates
  the documented protocol.

Continue using the existing `DrivePolicyBlockedError`,
`DriveRateLimitedError`, `DriveAuthorizationDeniedError`,
`DriveReauthorizationRequiredError`, and `DriveTemporaryUnavailableError`.

### 7.2 Telegram mapping

Every new reply is localized in English, Ukrainian, and Russian:

| Failure | User guidance |
|---|---|
| download/size/UTF-8/JSON/credentials | Download a fresh client JSON and send it as a Telegram document. |
| unsupported type | Create a client of type **TVs and Limited Input devices**; Web and Desktop clients do not work. |
| Google rejected client | Check its type and confirm that the OAuth client still exists and is enabled. |
| another setup is authorizing | Another administrator is connecting Drive; retry this document later without restarting preparation. |
| setup expired | Press Connect Drive and start again. |
| policy blocked | Check External/Internal audience selection, same-organization membership for Internal, and Google Workspace administrator policy. |
| rate limited | Wait before starting setup again. |
| temporary/network failure | Retry later; the previous Drive connection remains unchanged. |
| unexpected successful response | Update/restart the worker and retry; do not blame the JSON. |

Authorization denial, expiry, or provider failure during background polling
uses the existing sanitized authorization-outcome delivery path plus the new
exact state-registry transition. It completes only the matching durable receipt
and cannot clear or restore a replacement workflow.

### 7.3 Retry behavior

A document or initial-provider failure discards any staged generation and
returns the exact state to `preparing`; it does not consume the preparation.
The same administrator may upload a corrected document until the preparation
expires or is cancelled. Creating a fresh pending generation for each retry
prevents reuse of a discarded generation ID or expired device-flow window. A
successful challenge consumes the preparation by advancing to `authorizing`,
so later documents cannot create competing generations.

`DriveSetupBusyError` follows the same retry rule but does not discard or cancel
the other administrator's staged generation. Once that generation becomes
active, fails, expires, or is cancelled, the waiting administrator can resend
the same document while their 24-hour preparation remains current.

## 8. Security and privacy invariants

- Never log or reply with credential JSON, client secret, provider response
  body/description, device code, access token, refresh token, resumable-session
  URI, chat ID, or bot-token-bearing URL.
- Sanitized logs contain only an error class and closed reason/code where that
  reason contains no provider-controlled text.
- Credential-message deletion is exposure reduction, not a claim that Telegram
  caches or infrastructure were cryptographically erased.
- A forwarded credential document is never trusted or read, but is deleted if
  it was sent into an active preparation.
- Demotion between preparation and upload prevents reading and cancels the
  exact preparation without affecting an active Drive generation.
- Demotion during authorization cancels polling and discards only the exact
  staged generation before any later confirmation can activate it.
- Document fields never control outbound URLs.
- Provider-returned display values are bounded and validated before they reach
  Telegram. The verification URL is not hardcoded or rewritten.
- The existing AES-256-GCM storage and immutable installation key behavior are
  unchanged.

## 9. Edge-case behavior

| Edge case | Required behavior |
|---|---|
| Google Cloud setup takes longer than ten minutes | Preparation remains valid; pending generation starts only at upload. |
| Setup takes longer than 24 hours | Reply that setup expired and require Connect Drive again. |
| One leading UTF-8 BOM | Accept after stripping it. |
| Surrounding JSON whitespace | Accept through normal JSON parsing. |
| More than one BOM or replacement characters | Reject as invalid UTF-8/document. |
| Web envelope | Reject as unsupported client type before Google. |
| Desktop installed envelope | Parse only credentials and let Google reject the wrong client type with client-rejected guidance. |
| Deleted or disabled limited-input client | Map Google's `invalid_client` to client-rejected guidance. |
| External app remains in Testing | Instructions explicitly warn of seven-day authorization/token expiry. |
| Internal app with account outside its Workspace organization | Map `org_internal` to policy guidance without exposing provider text. |
| External personal or cross-organization setup | Instruct the administrator to publish the External app to avoid seven-day Testing expiry. |
| Device-code quota response uses `error_code` | Map `rate_limit_exceeded` to rate-limited. |
| Google omits interval | Default to five seconds. |
| Google omits `verification_url_complete` | Accept and store null. |
| Google returns malformed HTTP-200 JSON | Raise provider-response error. |
| Google returns oversized JSON or invalid display values | Abort bounded parsing and raise provider-response error. |
| Google request exceeds its transport timeout | Map to temporary unavailable; preserve explicit caller cancellation. |
| Telegram omits or lies about document size | Enforce the streaming 64-KiB cap. |
| Telegram honors Range for an oversized file | Request/observe one byte beyond the cap and reject rather than accepting a truncated prefix. |
| Telegram cannot delete the message | Continue safely and tell the administrator to delete it manually. |
| Manual-deletion warning also fails | Preserve the original setup result and log only a sanitized delivery failure. |
| Restart before upload | Clear preparation and require Connect Drive again. |
| Restart during device polling | Existing boot maintenance expires staged secrets; require a new setup. |
| Second Connect by same administrator | Cancel/replace only that administrator's preparation. |
| Two administrators prepare | Keep both secret-free preparations independently. |
| Two administrators upload | The first staged generation owns the installation-wide slot; the second remains preparing and receives retryable busy guidance. |
| Submission by another user/chat | Do not read; do not mutate the preparation or active connection. |
| Demotion/replacement during document download or initial Google request | Abort through the exact state controller; stale completion cannot stage, poll, or return the state. |
| Demotion during polling | Cancel and discard the exact staged generation; a stale outcome cannot reactivate or mutate replacement state. |
| Confirmation after effective deadline | Reject as expired, cancel polling, discard the staged generation, and complete the exact workflow failure. |

## 10. Automated tests

### 10.1 Google adapter

- Accept `verification_url` and expose it as `verificationUri`.
- Preserve the exact, case-sensitive user code.
- Accept absent `verification_url_complete` and map it to null.
- Default an absent interval to five seconds.
- Reject missing or malformed required success fields with
  `DriveProviderResponseError`.
- Reject a response body over 64 KiB, an invalid absolute HTTP(S)
  `verification_url`, credentials in that URL, non-printable/oversized display
  values, and unsafe numeric conversions with `DriveProviderResponseError`.
- Map device-code HTTP 403 `error_code: rate_limit_exceeded` to
  `DriveRateLimitedError`.
- Map token HTTP 401 `error: invalid_client` and a recognized device-code
  `invalid_client` to `DriveOAuthClientRejectedError`.
- Map transport timeout to `DriveTemporaryUnavailableError` while preserving
  explicit caller cancellation.
- Preserve redirect rejection, allowlisted discovery, cancellation, expiry,
  `slow_down`, policy, and sanitized transport behavior.

### 10.2 Application parser and submission

- Accept a real-shaped limited-input installed-client document.
- Accept one leading BOM and surrounding whitespace.
- Reject a Web document as unsupported; accept an `installed` document with
  inert unknown metadata and never use its endpoints, redirects, origins, or
  certificates.
- Let a Desktop `installed` document reach Google and map its authoritative
  `invalid_client` response to client-rejected guidance.
- Classify malformed JSON, invalid field types, missing credentials, unknown
  envelope shapes, and invalid identifiers. Unknown inert fields alone are not
  an error.
- Do not stage before validation succeeds.
- Map the staged-slot unique conflict to `DriveSetupBusyError` without touching
  the other generation.
- Discard the exact staged generation after initial-provider failure.
- Preserve an existing active generation after every failed replacement.
- Enforce the effective authorization deadline at polling and confirmation.

### 10.3 Telegram document adapter and handler

- Both menu and command entry call the same guide path.
- A direct command creates a `drive-setup` workflow receipt with the natural
  `admin-storage` parent; a menu launch reuses its supplied captured receipt.
- The pre-upload guide has Console and `wr:<receipt>:o` Cancel buttons and no
  generation-bearing callback.
- `DriveSetupStateRegistry` registers as the exact `drive-setup` draft
  canceller; replacement, origin return, and Home clear only matching state.
- Each locale renders no more than 3,500 characters and catalog shapes remain
  identical.
- Waiting more than ten minutes before upload still creates a fresh,
  unexpired pending generation.
- Preparation and pending expiry are tested with an injected clock and no real
  wall-clock waiting.
- Each typed error maps to its exact localized reply.
- A corrected document can be retried within the same preparation.
- The registry claims `authorizing` before the first read, so a second document
  cannot compete and demotion/replacement aborts an in-flight download or
  initial Google request. Failure returns only that exact state to `preparing`.
- A successful Google challenge records its effective deadline on the same
  authorizing state.
- Confirmation after the ten-minute pending deadline or earlier Google
  challenge expiry cannot activate and produces the exact expired outcome.
- Two administrators can prepare, while a competing upload receives busy
  guidance and remains retryable without cancelling the staged owner.
- Demotion in `preparing` removes only that binding; demotion in `authorizing`
  cancels polling and discards only the exact staged generation.
- Demotion, Cancel, or replacement during download/initial provider work aborts
  the exact signal; late resolution cannot stage, poll, or mutate replacement
  state.
- Background failure completes/removes only its exact receipt/generation;
  background success keeps the state until account confirmation.
- Terminal confirmation completes the exact durable receipt, delivers the
  result, and restores its authorized origin. Stale outcomes cannot complete a
  replacement receipt.
- Associated documents are deletion-attempted on success and every rejection
  path, including forwarded, oversized, failed-download, and post-demotion
  paths.
- Failed deletion produces the manual warning without exposing the credential.
- Failure to deliver that warning does not mask the original reply or state.
- Wrong user/chat submissions are not read and cannot take over a preparation.
- Cancel and replacement affect only the exact receipt-bound preparation.
- A range-respecting oversized download cannot be accepted as a truncated
  64-KiB prefix.

## 11. Manual release smoke test

Use a disposable Google account and dedicated project:

1. Start setup from the Storage menu and follow the guide from a fresh project.
2. Repeat entry through `/gdrive connect` and confirm identical instructions.
3. Upload a **TVs and Limited Input devices** JSON and receive Google's URL and
   user code.
4. Upload a Desktop or Web JSON and receive the specific unsupported/rejected
   client guidance.
5. If a Workspace organization is available, exercise an Internal project with
   an in-organization account and confirm that an outside account receives
   sanitized policy guidance. Otherwise record the Internal branch as not
   applicable.
6. Leave one disposable External project in Testing and verify the guide
   clearly warns why that mode is unsuitable; use an In-production project for
   the actual persistence test.
7. Complete authorization, confirm the intended account, and verify managed
   folder creation.
8. Confirm submitted credential messages disappear or produce the manual
   deletion warning.
9. With a second administrator, start another preparation while the first is
   authorizing and confirm the second receives retryable busy guidance without
   disturbing the first.
10. Inspect sanitized logs and verify that no credential, client ID/secret,
   provider body, code, token, chat ID, or private URL appears.
11. Restart after connection and verify refresh continues with the encrypted
   stored credential.

Record this procedure in the existing
`test/archive/google-drive-live-smoke.md` release-evidence format.

## 12. Acceptance criteria

- A valid limited-input client reaches the Google verification URL/code step.
- The adapter matches Google's documented success and quota response fields.
- Both Connect Drive entry points display the same fully detailed localized
  guide.
- Google Cloud preparation time does not consume the ten-minute authorization
  window that begins when a matching document is accepted.
- Polling and confirmation stop at the earlier of the ten-minute pending
  deadline and Google's returned challenge expiry.
- Web/Desktop, malformed document, Google rejection, policy, rate limit,
  busy, expiry, temporary/network, and protocol-response failures receive
  distinct, actionable localized replies.
- External and Internal audience instructions are accurate for personal,
  cross-organization, and same-Workspace deployments.
- No failure replaces or damages an existing active Drive connection.
- Multiple secret-free preparations may coexist, while only one
  installation-wide authorizing generation owns the staged slot.
- Pre-upload Cancel, workflow replacement, Home/origin return, demotion,
  background terminal failure, and successful confirmation all transition only
  their exact receipt/generation and complete the durable workflow correctly.
- Credential documents are deletion-attempted across all associated success
  and failure paths.
- Uploaded metadata never controls outbound URLs, and provider display values
  are bounded and validated without hardcoding Google's returned verification
  URL.
- Tests prove the guide remains within Telegram's message-length limit.
- Existing authorization polling, account confirmation, encryption, archive
  storage, retention, and `drive.file` scope behavior remain unchanged except
  where explicitly specified.

## 13. Out of scope

- Supporting Web or Desktop OAuth clients
- Changing the `drive.file` scope
- Persisting pre-upload preparation across worker restarts
- Changing credential encryption or archive storage
- Replacing the existing polling/account-confirmation workflow
- Allowing more than one installation-wide staged Drive generation
- Adding a vendor-hosted OAuth broker
- Adding a new database table or migration
- Exposing raw Google or Telegram error content

## 14. Documentation references

- [Google OAuth 2.0 for TV and Limited-Input Device Applications](https://developers.google.com/identity/protocols/oauth2/limited-input-device)
- [Google Auth Platform audience and publishing status](https://support.google.com/cloud/answer/15549945)
- [Google Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Telegram Bot API](https://core.telegram.org/bots/api)
