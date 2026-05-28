# Git commit convention

> Read when writing a commit message or PR title.

**Format:** `type(scope): subject`

- Conventional Commits style. Header is one line; subject is imperative, no trailing period.
- **Scope is required** and free-form `kebab-case` — pick the shortest meaningful one (`home`, `nav`, `contact-form`, `projects-page`, `seo`, `i18n`, `styling`, `deps`).
- Wrap body at 72 chars. Body explains **why** for non-trivial changes; **what** is in the diff.

## Allowed types

| Type | Use for |
| --- | --- |
| `feat` | New user-visible capability |
| `fix` | Bug fix |
| `chore` | Tooling, deps, config — no production code change |
| `docs` | Markdown / JSDoc / comments only |
| `refactor` | Code change with no behavior change |
| `style` | Formatting, whitespace, semicolons |
| `test` | Adding or fixing tests |
| `perf` | Performance improvement |
| `ci` | `.github/workflows/*`, CI scripts |
| `build` | Build system, bundler, `package.json` scripts |
| `misc` | Genuine miscellany that fits no other type — use sparingly |

## Examples

- `feat(home): add reduced-motion fallback to hero parallax`
- `fix(contact-form): reset Turnstile widget after server error`
- `refactor(projects-page): extract filter chip into local component`
- `docs(seo): document JSON-LD breadcrumb pattern`
- `chore(deps): bump next to 16.2.1`

## Discouraged

- Imperative-less subjects (`added X`, `fixing Y`) — use `add X`, `fix Y`.
- Empty or vague scopes (`feat(misc):` when a real scope exists, `feat():`).
- Multiple unrelated changes in one commit — split them.
