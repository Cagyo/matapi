# 06 — Bot Core

## Dependencies
- 01-database.md (users table)
- 00-overview.md (grammY, .env)

## Library Setup

grammY with plugins:
- `@grammyjs/runner` — auto-reconnect
- `@grammyjs/auto-retry` — rate limit handling
- `@grammyjs/conversations` — multi-step flows

## Bot Initialization

```typescript
import { Bot } from "grammy";
import { run } from "@grammyjs/runner";
import { autoRetry } from "@grammyjs/auto-retry";

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

bot.api.config.use(autoRetry());
bot.api.config.use((prev, method, payload) => {
  return prev(method, { ...payload, timeoutSeconds: 30 });
});

const runner = run(bot);
```

## Chat Architecture

- **Private chat only** for all interactions
- No group chat support
- Notifications sent to each user's private chat individually
- Unregistered users are ignored (bot does not respond)

## Polling Health

grammY runner handles basic reconnection. Additional safeguard:
- NetworkService verifies bot health independently
- If no update received in 2 minutes, force-restart polling
- Explicit 30s timeout on polling requests prevents half-open TCP sockets

## Role Model

| Role | Capabilities |
|------|-------------|
| Admin | All commands, config, user management, updates |
| User | `/status`, `/logs`, `/camera`, receive notifications |

## Role Guard

```typescript
// src/telegram/guards/role.guard.ts
function adminOnly(ctx, next) {
  const user = db.select().from(users)
    .where(eq(users.telegramId, ctx.from.id))
    .get();

  if (!user || user.role !== 'admin') {
    return ctx.reply("❌ Admin access required");
  }
  return next();
}
```

Applied as middleware on admin-only commands.

## Admin Claim Flow (First Boot)

1. Worker starts, checks `users` table — empty
2. Worker enters "awaiting admin" mode — indefinitely waits for `/claim_admin`
3. First user to send `/claim_admin` becomes admin
4. Command permanently disabled after first successful claim
5. Additional admins added via `/promote`

No time window, no claim code. Simple infinite wait.

## Interrupted Conversations

If bot restarts during a multi-step conversation (e.g., `/config add`), conversation state is lost (grammY conversations are in-memory). On next message: "Previous operation was interrupted. Please start again."

## Long Operations UX

Commands that take time immediately reply with status + typing indicator:
```typescript
await ctx.replyWithChatAction('upload_photo');
// ... process ...
await ctx.reply("Result");
```

## Error Handling

- Every command wrapped in try/catch at handler level
- Error response: "❌ Failed to [action]: [reason]"
- Full stack trace logged to PM2 logs
- Never propagate unhandled exceptions to process
