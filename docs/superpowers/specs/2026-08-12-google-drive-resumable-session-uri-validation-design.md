# Google Drive Resumable Session URI Validation Fix

**Date:** 2026-08-12

## Problem

The archive scheduler runs every two minutes, registers an upload attempt, and
then fails before sending file bytes with:

```text
Archive upload failed: Google resumable Location is not allowlisted
```

Google successfully initiates the resumable upload and returns its session URI
in the `Location` response header. The worker rejects that URI because
`validateSessionUri` requires the query string to contain exactly two keys,
`uploadType` and `upload_id`. Google documents the returned value as the session
URI clients must save and use, but does not make the exact query-key set part of
the protocol contract. An additional Google-controlled query parameter therefore
causes every scheduler retry to fail before upload begins.

## Scope

This fix changes only resumable session URI validation and its tests. It does
not change scheduler cadence, queue fairness, event-triggered dispatch, upload
chunking, retry state, encryption, or Google OAuth behavior.

Immediate dispatch after a completed Motion event remains separate work. The
current outage is resolved when the existing two-minute dispatcher can use the
valid session URI returned by Google.

## Design

Treat the returned session URI as a Google-issued opaque capability while
retaining the existing server-side request-forgery protections.

The validator will continue to require all of these properties:

- absolute HTTPS URL;
- host exactly `www.googleapis.com` with no non-default port;
- no username or password;
- path exactly `/upload/drive/v3/files`;
- no fragment;
- exactly one non-empty `upload_id` value; and
- `uploadType`, when present, has exactly one value equal to `resumable`.

Other query parameters issued by Google are accepted and preserved. The worker
does not interpret, remove, reorder, or synthesize them. The original header
value is stored and used for subsequent `PUT` requests after validation.

Requiring `uploadType=resumable` only when it is present avoids depending on a
query field that Google does not define as the identity of the returned session
capability. The unique non-empty `upload_id`, fixed Google origin, and fixed
Drive upload path remain the capability and network-destination guards.

## Data Flow

1. Google returns a successful resumable-initiation response with `Location`.
2. `GoogleResumableUploadGateway.begin` passes the header to
   `validateSessionUri`.
3. Validation rejects unsafe origins, paths, credentials, fragments, or
   ambiguous session identifiers.
4. Validation accepts Google-supplied auxiliary query parameters without
   changing the URI.
5. The complete URI is encrypted and persisted as the durable upload session.
6. Chunk upload and status-query requests use that validated URI unchanged.

## Error Handling and Security

Unsafe or ambiguous values continue to raise `DriveConfigurationError` with the
sanitized message `Google resumable Location is not allowlisted`. Logs never
include the URI, its query values, OAuth material, Drive IDs, or local paths.

The relaxed query handling must not permit:

- a foreign or suffix-confusable hostname;
- HTTP or a non-default port;
- embedded credentials;
- a fragment;
- a different API path;
- a missing, empty, or duplicated `upload_id`; or
- a present `uploadType` with a value other than `resumable`, including
  duplicate values.

## Testing

Test-driven implementation will first add a failing regression test proving
that a documented Drive session URI with an extra Google-supplied query
parameter is accepted and preserved.

Focused security tests will prove that the validator still rejects foreign
hosts, credentials, fragments, wrong paths, missing or duplicate `upload_id`
values, and invalid or duplicate `uploadType` values. Existing resumable upload
tests must remain green.

Verification will run the focused resumable-gateway and archive upload tests,
then the full archive test suite, type/build checks, and lint scoped to the
changed files or the repository command when feasible.

## Success Criteria

- A valid Google Drive resumable session URI with auxiliary query parameters is
  accepted without mutation.
- The scheduler can progress past session initiation and upload bytes.
- Existing origin, path, credential, fragment, and unique-session-ID security
  checks remain enforced.
- Retry, encryption, durable session recovery, and upload verification behavior
  are unchanged.
