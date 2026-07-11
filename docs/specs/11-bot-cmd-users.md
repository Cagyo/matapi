# 11 — /invite, /promote, /demote, /start, /claim_admin Commands

## Dependencies
- 06-bot-core.md (bot instance, role guard)
- 01-database.md (users table, invite_codes table)
- ../ports-and-adapters.md (`UserRepositoryPort`, `RolePort`, `NotifierPort`)

> All user-facing strings live in [`src/locales/en.ts`](../../src/locales/en.ts). The literals below are illustrative.

---

## /claim_admin

### Access
Anyone holding the setup-generated claim token — but only valid until the first admin is created.

### Syntax
```
/claim_admin <claim-token>
```

### Behavior
First-boot admin bootstrap. The setup wizard generates `CLAIM_ADMIN_TOKEN`, writes it only to the mode-`0600` `.env`, and shows `/claim_admin <claim-token>` once on the local completion page. The handler delegates to `ClaimAdminUseCase`:

1. `UserRepositoryPort.countAdmins()` — if `> 0`, throw `AdminAlreadyClaimedError`.
2. `AdminClaimCredentialPort` verifies the supplied token against `CLAIM_ADMIN_TOKEN`.
3. `UserRepositoryPort.claimFirstAdmin()` atomically inserts the sender with `role = 'admin'` and `createdBy = NULL`.
4. Reply: "✅ You are now the admin of this Home Worker."

The token remains in `.env`, but `claimFirstAdmin()` allows only one successful claim. After success, every subsequent `/claim_admin <claim-token>` is rejected by the same use case, including concurrent attempts.

### Error Cases
| Condition | Domain error | Reply (from `en.ts`) |
|-----------|--------------|----------------------|
| Admin already exists | `AdminAlreadyClaimedError` | "❌ This Home Worker already has an admin." |
| Missing or invalid claim token | `InvalidAdminClaimTokenError` | "❌ Invalid setup claim token. Use the command shown by the setup wizard." |
| Claim token is not configured | `AdminClaimNotConfiguredError` | "❌ Admin claiming is disabled until CLAIM_ADMIN_TOKEN is configured." |
| DB write fails | (unmapped — generic) | "❌ Failed to claim admin role." |

---

## /invite

### Access
Admin only

### Syntax
```
/invite
```

### Behavior
1. Generate random 8-character alphanumeric code
2. Store in `invite_codes` table with `createdBy` = admin's telegram_id
3. Reply with the code

### Output
```
🔗 Invite code: AB3F9K2M
Share this with the new user. They should send:
/start AB3F9K2M
```

### Notes
- Codes are one-time use
- No expiry (simple approach)
- Used codes remain in DB with `usedBy` and `usedAt` set

---

## /start <invite_code>

### Access
Anyone (this is how new users register)

### Syntax
```
/start <code>
```

### Behavior
1. Look up code in `invite_codes` table
2. If not found or already used → reject
3. Create user in `users` table with `role = 'user'`
4. Mark invite code as used
5. Notify the inviting admin

### Output
```
✅ Welcome, Alex! You're registered as a user.
```

### To inviting admin
```
👤 Alex (@alex_t) joined using your invite code.
```

### Error Cases
| Condition | Response |
|-----------|----------|
| No code provided | "Send /start <invite_code> to register" |
| Invalid code | "❌ Invalid invite code" |
| Code already used | "❌ This invite code has already been used" |
| User already registered | "You're already registered" |

---

## /promote <name|id:telegram_id>

### Access
Admin only

### Syntax
```
/promote <name|id:telegram_id>
```

### Behavior
1. Resolve `id:<telegram_id>` directly to that immutable Telegram ID, or accept a name only when it identifies exactly one registered user
2. If already admin → inform
3. Update role to `admin`
4. Notify the promoted user

Names are a convenience selector, not a tie-breaker. If more than one user has
the requested name, no role is changed. The reply lists the matching candidates
with their IDs and instructs the admin to retry with `/promote id:<telegram_id>`.

### Output
```
✅ Alex promoted to admin.
```

### To promoted user
```
🎉 You've been promoted to admin by [admin_name].
```

### Error Cases
| Condition | Response |
|-----------|----------|
| User not found | "❌ User not found" |
| Name matches multiple users | List candidate IDs; retry with `/promote id:<telegram_id>` |
| Already admin | "ℹ️ Alex is already an admin" |

---

## /demote <name|id:telegram_id>

### Access
Admin only

### Syntax
```
/demote <name|id:telegram_id>
```

### Behavior
1. Resolve `id:<telegram_id>` directly to that immutable Telegram ID, or accept a name only when it identifies exactly one registered user
2. If not admin → inform
3. Atomically update role to `user` only if another admin remains
4. Notify the demoted user

If a name is ambiguous, no role is changed. The reply lists the matching
candidates with their IDs and instructs the admin to retry with
`/demote id:<telegram_id>`.

### Output
```
✅ Alex demoted to user.
```

### Error Cases
| Condition | Response |
|-----------|----------|
| User not found | "❌ User not found" |
| Name matches multiple users | List candidate IDs; retry with `/demote id:<telegram_id>` |
| Not admin | "ℹ️ Alex is already a regular user" |
| Final admin | "❌ Cannot demote the final admin." |

Self-demotion is allowed only while another admin remains. The repository
performs this check and role update atomically so concurrent demotions cannot
leave the worker without an admin and reactivate the one-use claim token.
