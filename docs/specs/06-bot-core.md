# 06 — Bot Core

## Dependencies
- 01-database.md (users table)
- 00-overview.md (grammY, .env)
- 11-bot-cmd-users.md (`/claim_admin`, role commands)
- ../ports-and-adapters.md (`RolePort`, `UserRepositoryPort`, `NotifierPort`)
- ../error-handling.md (handler error mapping), `src/locales/en.ts` (all user-facing strings)

> **User-facing copy rule.** Every string the bot replies with comes from [`src/locales/en.ts`](../../src/locales/en.ts) (see ../naming-and-conventions.md and ../error-handling.md → Interface boundary mapping). Inline strings in the examples below are illustrative — in code they MUST be locale keys.

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

Guards live in `telegram/interfaces/` and depend on a `RolePort` (or `UserRepositoryPort.findById`) — **never** on Drizzle directly (../architecture.md → Anti-patterns).

```typescript
// src/telegram/interfaces/role.middleware.ts
export function adminOnly(roles: RolePort, en: Locale) {
  return async (ctx, next) => {
    const role = await roles.roleOf(ctx.from!.id);
    if (role !== 'admin') {
      await ctx.reply(en.common.adminRequired);   // locale key, not a literal
      return;
    }
    return next();
  };
}
```

Applied as middleware on admin-only commands.

## Admin Claim Flow (First Boot)

See [11-bot-cmd-users.md → /claim_admin](11-bot-cmd-users.md#claim_admin) for the full UX and use-case shape. Summary:

1. Worker starts; `UserRepositoryPort.countAdmins()` returns 0.
2. Worker enters "awaiting admin" mode — indefinitely waits for `/claim_admin`.
3. First user to send `/claim_admin` becomes admin (via `ClaimAdminUseCase`).
4. Command rejected after first successful claim.
5. Additional admins added via `/promote`.

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

- Every handler wraps the use-case call in `try/catch` and maps domain errors to locale keys per ../error-handling.md → *Interface boundary mapping*.
- Generic fallback reply uses `en.common.error(...)` — never `error.message`.
- Full stack trace logged via Nest `Logger` (never `console.log` / `console.error`).
- Never propagate unhandled exceptions to the process — PM2 restart is reserved for genuine crashes, not bot input.
