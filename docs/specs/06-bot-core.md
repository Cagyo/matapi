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

## Authoritative Home callback pipeline

`/menu` is handled by
[`src/telegram/interfaces/home.handler.ts`](../../src/telegram/interfaces/home.handler.ts).
The composition root binds `HOME_SESSION_STORE` to `DrizzleHomeSessionStore`
in real mode and `InMemoryHomeSessionStore` when `BOT_MODE=mock`; it binds
`HOME_MESSAGE_DELIVERY` similarly to `TelegramHomeMessageAdapter` or
`InMemoryHomeMessageDeliveryAdapter`. `HOME_TOKEN_GENERATOR` is the crypto
96-bit base64url generator and `HOME_HEALTH_SNAPSHOT` is the bounded in-memory
snapshot adapter in every mode.

For every private update, `GrammyBotGateway` installs
[`homeCallbackAckMiddleware`](../../src/telegram/interfaces/home-callback-ack.middleware.ts)
before `sequentialize(homeUpdateConstraints)`, then locale middleware and
handlers. The acknowledgement middleware promptly calls
`answerCallbackQuery` for Home payloads (`h:`) and the recovery action (`ho`),
without preventing later handling if acknowledgement fails. Sequentialization
uses both `home:chat:<chatId>` and `home:user:<userId>` keys, so competing
private-user/chat Home updates are processed in order before locale/role lookup
and callback validation. Database CAS remains the authority across a restart.

Normal callback data is UTF-8 bounded to Telegram's 64-byte limit and has the
format `h:<16-character-base64url-token>:<base36-revision>:<action>[:<page>]`.
The action codes are `h` (Home), `s` (Sensors page), `c` (camera), `n`
(notifications), `m` (More), `k` (Check now), and `x` (Close); `ho` is the
stateless Open-new-Home recovery action. The handler acknowledges first, parses
the bounded value, loads current locale/role, validates user/chat/message/token/
revision, then renders or executes. A stale, closed, or unavailable authority
never mutates state and receives localized recovery.

Slice 2 keeps camera, notification, and More destinations as a **transitional
external-workflow boundary**: after Home validation, `CameraHandler` or
`LegacyMenuHandler` owns those flows. They do not reuse the Home session or
perform Home protocol transitions. The shared Return-to-Home contract for
external workflows is deferred to Slice 4; this slice makes no claim that
every legacy terminal screen has a Home button.

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

### Drive-auth continuations

Starting `/gdrive_auth` is not sufficient authorization for its later
messages. Every Drive-auth continuation resolves the sender's **current** role
before processing input: this includes both text snippets and uploaded
configuration documents. A user demoted after starting the flow is rejected
and their pending Drive-auth state is cleared. The role check is repeated
immediately before the Drive configuration write as well. The remaining
role-check-to-filesystem-write boundary is not atomic.

## Admin Claim Flow (First Boot)

See [11-bot-cmd-users.md → /claim_admin](11-bot-cmd-users.md#claim_admin) for the full UX and use-case shape. Summary:

1. Worker starts; `UserRepositoryPort.countAdmins()` returns 0.
2. Setup has generated `CLAIM_ADMIN_TOKEN`, stored it only in the mode-`0600` `.env`, and shown `/claim_admin <claim-token>` once on the local completion page.
3. Worker enters "awaiting admin" mode — indefinitely waits for a valid `/claim_admin <claim-token>`.
4. First user with that token becomes admin (via `ClaimAdminUseCase`).
5. `UserRepositoryPort.claimFirstAdmin()` is atomic, so the credential is unusable after the first successful claim, including for concurrent attempts.
6. All later claim commands are rejected.
7. Additional admins added via `/promote`.

There is no time window. The setup token is required only until the first claim succeeds.

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
