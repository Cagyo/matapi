# Docs Index — Token-Efficient Routing

Two doc trees live here. Load the right one for the task:

| Tree | Purpose | When to load |
|---|---|---|
| `docs/*.md` (this folder) | **How we build** — architecture, conventions, testing, DI, commits | Touching code, adding a module, reviewing a PR |
| [`docs/specs/`](specs/INDEX.md) | **What we build** — system design: sensors, bot, camera, OTA, install | Building a specific feature, looking up wire format / pin layout / command UX |

> **Token rule:** Do not bulk-load this folder. Pick the docs that match the task from the table below; follow each doc's `## Dependencies` line for transitive loads.

## Architecture & Process — `docs/*.md`

| Task | Load (in order) |
|---|---|
| Adding a new bounded context / Nest module | [architecture](architecture.md), [naming-and-conventions](naming-and-conventions.md), [dependency-injection](dependency-injection.md) |
| Adding a port or replacing an adapter | [architecture](architecture.md), [ports-and-adapters](ports-and-adapters.md) |
| Planning or executing module migration | [migration-checklist](migration-checklist.md), [architecture](architecture.md), [ports-and-adapters](ports-and-adapters.md), [testing](testing.md) |
| Writing tests for new code | [testing](testing.md) |
| Designing an error type / failure path | [error-handling](error-handling.md) |
| Wiring Nest DI / picking an injection token | [dependency-injection](dependency-injection.md) |
| Naming a file / class / interface | [naming-and-conventions](naming-and-conventions.md) |
| Writing a commit / PR title | [commits](commits.md) |

## System Design — `docs/specs/`

Routed by [`docs/specs/INDEX.md`](specs/INDEX.md). Examples:

| Task | Load |
|---|---|
| Add a digital (GPIO) sensor | specs 02, 03 |
| Add UART/CO2 sensor logic | specs 02, 04 |
| Add a Telegram command | specs 06 + matching `bot-cmd-*` |
| Camera / Drive sync | specs 20, 21, 15 |
| OTA / system update | specs 24, 13, 18 |

## Cross-Tree Workflow

Most feature tasks need one from each tree:

1. Read the spec to learn **what** must work (`docs/specs/NN-*.md`).
2. Read [architecture.md](architecture.md) to learn **where** the code goes.
3. Read [testing.md](testing.md) to learn **how** to prove it works.

## Hard Rules for Agents

1. **Always start here**, not in `docs/specs/` directly — this index decides which tree to enter.
2. **Architecture is non-negotiable for new modules.** Pre-existing modules may be in transitional state ([architecture.md → Migration](architecture.md#migration-policy)) — verify before assuming a pattern is canonical.
3. For code-level questions, source files linked from [CLAUDE.md](../CLAUDE.md) beat docs.
4. `specs/home-worker-spec.md` is the original prose spec — only load when the numbered specs are insufficient.
