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

## /promote <user>

### Access
Admin only

### Syntax
```
/promote <username_or_name>
```

### Behavior
1. Find user by Telegram username or display name
2. If already admin → inform
3. Update role to `admin`
4. Notify the promoted user

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
| Already admin | "ℹ️ Alex is already an admin" |

---

## /demote <user>

### Access
Admin only

### Syntax
```
/demote <username_or_name>
```

### Behavior
1. Find user
2. If not admin → inform
3. Update role to `user`
4. Notify the demoted user

### Output
```
✅ Alex demoted to user.
```

### Error Cases
| Condition | Response |
|-----------|----------|
| User not found | "❌ User not found" |
| Not admin | "ℹ️ Alex is already a regular user" |
| Demoting self | Allowed (admin accepts the risk) |
