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
- Accept only an OAuth client created with the exact Google application type
  **TVs and Limited Input devices**. Do not support Web or Desktop clients.
- Parse Google's documented `verification_url` and preserve the case-sensitive
  `user_code` without modification.
- Recognize both `error` and the documented device-code `error_code` field.
- Classify failures with typed errors at their owning boundaries. Do not infer
  failure type from exception-message text.
- Preserve an existing active Drive connection after every failed replacement.
- Delete every credential document associated with an active preparation on a
  best-effort basis, including rejected documents.
- Keep pre-upload preparation in process memory. A restart intentionally
  clears it and asks the administrator to start again.
- Keep the implementation within the existing `archive` and `telegram`
  boundaries; no new bounded context or database migration is needed.

## 4. User flow

### 4.1 Entry

Both entry points call `GdriveHandler.handleConnect()`:

- Storage & backup → Connect Drive; and
- `/gdrive connect` in a private administrator chat.

The handler reauthorizes the current administrator and cancels that
administrator's older preparation or authorizing generation. A menu launch
uses the supplied receipt. A direct `/gdrive connect` launch first calls
`WorkflowEntryCoordinator.begin()` with the natural `admin-storage` parent so
both entry points own the same receipt-bound `drive-setup` workflow. The
handler then records a secret-free preparation binding and sends the detailed
guide with two controls:

- **Open Google Cloud Console** — URL button; and
- **Cancel** — existing receipt-bound callback.

The preparation binding contains only administrator ID, private chat ID,
workflow receipt ID, and expiry. It contains no client ID, client secret,
device code, token, or provider URL.

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

### 4.3 Document submission

Uploading a document acts as Continue; no Ready button is introduced. Before
reading it, the handler rechecks:

- private chat;
- current administrator role;
- exact user/chat preparation binding;
- current workflow receipt; and
- preparation expiry.

Only after those checks does `BeginDriveConnectionUseCase` create the actual
ten-minute pending generation. The handler then downloads, parses, validates,
stages, and submits the client to Google.

The handler keeps one explicit per-user/chat state union:

- `preparing` — receipt and preparation expiry, with no credentials; or
- `authorizing` — the freshly created `PendingDriveConnection` used by the
  authorization and confirmation callbacks.

Document or initial-provider failure returns the state to `preparing` when the
preparation receipt is still current. Successfully receiving a valid Google
challenge advances it to `authorizing`; additional documents cannot start a
second generation. Cancel, replacement, demotion, expiry, and terminal success
remove the exact state and discard or cancel any exact staged generation.

The message document is deleted in `finally` whenever it matched an active
Drive preparation. This includes forwarded, oversized, malformed, non-UTF-8,
download-failed, and post-demotion submissions. If Telegram deletion fails,
the administrator receives the localized manual-deletion warning.

### 4.4 Google authorization

For a valid client, the worker:

1. requests only `https://www.googleapis.com/auth/drive.file`;
2. obtains and validates Google's device-code response;
3. shows the returned verification URL and exact user code;
4. polls at Google's returned interval, including `slow_down` handling;
5. resolves the authorized account identity;
6. asks the administrator to confirm that account; and
7. atomically activates the new generation after folder verification.

The existing active generation remains authoritative until step 7 succeeds.

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
>    choose External under Audience, add a contact email, accept the Google API
>    Services User Data Policy, and finish setup.
> 5. Open Google Auth Platform → Data Access → Add or remove scopes. Add
>    `https://www.googleapis.com/auth/drive.file`, then save.
> 6. Open Google Auth Platform → Audience and publish the app so its status is
>    In production. Do not leave it in Testing: Google expires Testing
>    authorizations and refresh tokens after seven days.
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
> requested `drive.file` permission.
>
> If setup is interrupted or the bot restarts, press Connect Drive again.

Each rendered localized guide must contain no more than 3,500 characters,
leaving margin below Telegram's 4,096-character `sendMessage` limit. The
Console is opened through the URL button, so the guide does not rely on a link
preview.

## 6. Component responsibilities

### 6.1 Telegram interface

`GdriveHandler` owns preparation binding, live role/binding checks, keyboard
construction, credential-message deletion, and typed error-to-locale mapping.
It never examines raw provider content or matches exception message strings.

`TelegramDriveClientDocumentAdapter` owns the declared-size and streaming
64-KiB limit, UTF-8 decoding, and Telegram download failures. It must not log a
file URL because Telegram download URLs contain the bot token.

### 6.2 Archive application

The installed-client parser owns JSON and credential-envelope validation. It
accepts surrounding JSON whitespace and one leading UTF-8 BOM. It allows only
the expected downloaded fields and returns only `clientId` and `clientSecret`.
Uploaded endpoint, redirect, certificate, and origin fields never control a
worker request.

The parser explicitly classifies known `web` envelopes and known Desktop
`installed` shapes as unsupported client type. A syntactically plausible
limited-input `installed` shape may still be rejected by Google if the client
was deleted, disabled, or does not belong to the device application type.

The application use case stages credentials only after parsing succeeds. If
the initial Google request fails, it discards that staged generation and
leaves the previous active generation untouched.

Preparation and pending-expiry decisions use the injected `ClockPort`; no
Drive setup test or production branch reads `Date.now()` directly. This keeps
the 24-hour preparation and ten-minute pending windows deterministic and on
the same clock authority as the workflow receipt.

### 6.3 Google infrastructure

`GoogleDeviceAuthorizationAdapter` owns protocol fields and provider error
mapping. On success it requires non-empty `device_code`, `user_code`,
`verification_url`, and positive `expires_in`. `interval` defaults to five
seconds when absent. `verification_url_complete` is optional and maps to null
when absent.

The adapter accepts only the existing hardcoded/discovered allowlisted Google
endpoints and still rejects redirects. It never trusts endpoint values from
the uploaded client document.

On failure it checks the documented response discriminator appropriate to the
endpoint. Device-code `error_code: "rate_limit_exceeded"` maps to
`DriveRateLimitedError`; OAuth `error: "invalid_client"` maps to a dedicated
client-rejected error. Unknown 4xx responses are not exposed to Telegram and
map to a sanitized provider/temporary failure according to the typed contract.

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
| setup expired | Press Connect Drive and start again. |
| policy blocked | Check External/Internal audience selection and Google Workspace administrator policy. |
| rate limited | Wait before starting setup again. |
| temporary/network failure | Retry later; the previous Drive connection remains unchanged. |
| unexpected successful response | Update/restart the worker and retry; do not blame the JSON. |

Authorization denial or expiry that occurs during background polling continues
through the existing sanitized authorization-outcome path.

### 7.3 Retry behavior

A document or initial-provider failure discards any staged generation and
returns the exact state to `preparing`; it does not consume the preparation.
The same administrator may upload a corrected document until the preparation
expires or is cancelled. Creating a fresh pending generation for each retry
prevents reuse of a discarded generation ID or expired device-flow window. A
successful challenge consumes the preparation by advancing to `authorizing`,
so later documents cannot create competing generations.

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
- Document fields never control outbound URLs.
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
| Desktop installed envelope | Reject when distinguishable; otherwise Google rejection receives client-rejected guidance. |
| Deleted or disabled limited-input client | Map Google's `invalid_client` to client-rejected guidance. |
| External app remains in Testing | Instructions explicitly warn of seven-day authorization/token expiry. |
| Workspace policy or Internal audience mismatch | Map to policy guidance without exposing provider text. |
| Device-code quota response uses `error_code` | Map `rate_limit_exceeded` to rate-limited. |
| Google omits interval | Default to five seconds. |
| Google omits `verification_url_complete` | Accept and store null. |
| Google returns malformed HTTP-200 JSON | Raise provider-response error. |
| Telegram omits or lies about document size | Enforce the streaming 64-KiB cap. |
| Telegram cannot delete the message | Continue safely and tell the administrator to delete it manually. |
| Restart before upload | Clear preparation and require Connect Drive again. |
| Restart during device polling | Existing boot maintenance expires staged secrets; require a new setup. |
| Second Connect by same administrator | Cancel/replace only that administrator's preparation. |
| Submission by another user/chat | Do not read; do not mutate the preparation or active connection. |

## 10. Automated tests

### 10.1 Google adapter

- Accept `verification_url` and expose it as `verificationUri`.
- Preserve the exact, case-sensitive user code.
- Accept absent `verification_url_complete` and map it to null.
- Default an absent interval to five seconds.
- Reject missing or malformed required success fields with
  `DriveProviderResponseError`.
- Map device-code HTTP 403 `error_code: rate_limit_exceeded` to
  `DriveRateLimitedError`.
- Map OAuth `error: invalid_client` to `DriveOAuthClientRejectedError`.
- Preserve redirect rejection, allowlisted discovery, cancellation, expiry,
  `slow_down`, policy, and sanitized transport behavior.

### 10.2 Application parser and submission

- Accept a real-shaped limited-input installed-client document.
- Accept one leading BOM and surrounding whitespace.
- Reject Web and distinguishable Desktop documents as unsupported.
- Classify malformed JSON, invalid field types, missing credentials, unknown
  fields, and invalid identifiers.
- Do not stage before validation succeeds.
- Discard the exact staged generation after initial-provider failure.
- Preserve an existing active generation after every failed replacement.

### 10.3 Telegram document adapter and handler

- Both menu and command entry call the same guide path.
- A direct command creates a `drive-setup` workflow receipt with the natural
  `admin-storage` parent; a menu launch reuses its supplied captured receipt.
- The guide has Console and Cancel buttons.
- Each locale renders no more than 3,500 characters and catalog shapes remain
  identical.
- Waiting more than ten minutes before upload still creates a fresh,
  unexpired pending generation.
- Preparation and pending expiry are tested with an injected clock and no real
  wall-clock waiting.
- Each typed error maps to its exact localized reply.
- A corrected document can be retried within the same preparation.
- A successful Google challenge transitions preparation to authorizing and
  prevents a second document from creating a competing generation.
- Associated documents are deletion-attempted on success and every rejection
  path, including forwarded, oversized, failed-download, and post-demotion
  paths.
- Failed deletion produces the manual warning without exposing the credential.
- Wrong user/chat submissions are not read and cannot take over a preparation.
- Cancel and replacement affect only the exact receipt-bound preparation.

## 11. Manual release smoke test

Use a disposable Google account and dedicated project:

1. Start setup from the Storage menu and follow the guide from a fresh project.
2. Repeat entry through `/gdrive connect` and confirm identical instructions.
3. Upload a **TVs and Limited Input devices** JSON and receive Google's URL and
   user code.
4. Upload a Desktop or Web JSON and receive the specific unsupported/rejected
   client guidance.
5. Leave one disposable project in Testing and verify the guide clearly warns
   why that mode is unsuitable; use an In-production project for the actual
   persistence test.
6. Complete authorization, confirm the intended account, and verify managed
   folder creation.
7. Confirm submitted credential messages disappear or produce the manual
   deletion warning.
8. Inspect sanitized logs and verify that no credential, client ID/secret,
   provider body, code, token, chat ID, or private URL appears.
9. Restart after connection and verify refresh continues with the encrypted
   stored credential.

## 12. Acceptance criteria

- A valid limited-input client reaches the Google verification URL/code step.
- The adapter matches Google's documented success and quota response fields.
- Both Connect Drive entry points display the same fully detailed localized
  guide.
- Google Cloud preparation time does not consume the ten-minute upload/device
  window.
- Web/Desktop, malformed document, Google rejection, policy, rate limit,
  expiry, temporary/network, and protocol-response failures receive distinct,
  actionable localized replies.
- No failure replaces or damages an existing active Drive connection.
- Credential documents are deletion-attempted across all associated success
  and failure paths.
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
- Adding a vendor-hosted OAuth broker
- Adding a new database table or migration
- Exposing raw Google or Telegram error content

## 14. Documentation references

- [Google OAuth 2.0 for TV and Limited-Input Device Applications](https://developers.google.com/identity/protocols/oauth2/limited-input-device)
- [Google Auth Platform audience and publishing status](https://support.google.com/cloud/answer/15549945)
- [Google Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Telegram Bot API](https://core.telegram.org/bots/api)
