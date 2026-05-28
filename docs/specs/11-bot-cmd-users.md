# 11 — /invite, /promote, /demote, /start Commands

## Dependencies
- 06-bot-core.md (bot instance, role guard)
- 01-database.md (users table, invite_codes table)

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
