import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = resolve('migrations');

/**
 * Statements that make a migration one-way. `DROP INDEX` is deliberately absent:
 * an index is not data, and re-running the previous release's code against a
 * missing index still works.
 */
const IRREVERSIBLE = /\b(DROP\s+COLUMN|DROP\s+TABLE|RENAME\s+TO|RENAME\s+COLUMN)\b/iu;

/**
 * Migrations that already violated spec 24's additivity policy when this check
 * was introduced. Frozen baseline — the point is to stop new ones, not to
 * rewrite applied history. Never add to this list: an OTA rollback restores code
 * only, so old code meets a forward schema and fails every query touching a
 * rebuilt table. `scripts/update.sh` snapshots the database before migrating to
 * survive exactly that, but the snapshot costs every write made during the
 * update window, which is a real price rather than a free undo.
 */
const GRANDFATHERED: readonly string[] = [
  '0007_flashy_golden_guardian.sql',
  '0009_bored_silhouette.sql',
  '0014_thankful_blink.sql',
  '0016_perpetual_pepper_potts.sql',
];

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

describe('migration additivity policy (spec 24)', () => {
  it('adds no new irreversible migration', () => {
    const offenders = migrationFiles().filter(
      (name) =>
        !GRANDFATHERED.includes(name) &&
        IRREVERSIBLE.test(readFileSync(join(MIGRATIONS, name), 'utf8')),
    );

    expect(
      offenders,
      'A rollback restores code but never un-applies a migration. Add columns with defaults instead of dropping, renaming or rebuilding tables — see docs/specs/24-ota.md -> Migration Safety.',
    ).toEqual([]);
  });

  it('keeps the grandfathered baseline honest', () => {
    const present = new Set(migrationFiles());

    // A stale entry would silently widen the exemption for a future migration
    // that happens to reuse the name.
    expect(GRANDFATHERED.filter((name) => !present.has(name))).toEqual([]);
    // And each listed file must still actually violate the policy, or it should
    // simply be removed from the list.
    expect(
      GRANDFATHERED.filter(
        (name) => !IRREVERSIBLE.test(readFileSync(join(MIGRATIONS, name), 'utf8')),
      ),
    ).toEqual([]);
  });
});
