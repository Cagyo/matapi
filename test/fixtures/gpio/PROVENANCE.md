# GPIO CLI fixtures

Real command output pinned per libgpiod major. The syntax module's parsers are
unit-tested against these files; when Debian bumps libgpiod, these fixtures are
what catches it.

| Dir | Source | Status |
|---|---|---|
| v1/ | Raspberry Pi 3, Raspberry Pi OS bookworm, libgpiod 1.6.3 | **PROVISIONAL — replace via scripts/capture-gpio-fixtures.sh** |
| v2/ | Raspberry Pi 5, Raspberry Pi OS trixie, libgpiod 2.x | **PROVISIONAL — replace via scripts/capture-gpio-fixtures.sh** |

To re-capture on a board:

    scripts/capture-gpio-fixtures.sh test/fixtures/gpio/v1 gpiochip0 26

then commit the diff and update this table (board, OS, version, date, drop
PROVISIONAL). If a captured shape differs from what the parsers in
src/sensors/infrastructure/libgpiod-cli.syntax.ts expect, fix the parser AND
its test in the same commit — the fixture is the source of truth, not the code.
