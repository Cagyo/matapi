import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
 * drizzle-kit's table-recreate scaffolding. SQLite cannot `ALTER` a `CHECK`
 * constraint, so widening one is emitted as: build `__new_<table>`, copy every
 * row across, drop the original, rename the copy back. All four statements must
 * be present and agree on the table name before the rebuild is even considered —
 * a lone `DROP TABLE` or a copy that never happened is still an offender.
 */
const BREAKPOINT = '--> statement-breakpoint';
const REBUILD_CREATE = /^CREATE\s+TABLE\s+[`"]?__new_(\w+)[`"]?\s*\(([\s\S]*)\)$/iu;
const REBUILD_COPY =
  /^INSERT\s+INTO\s+[`"]?__new_(\w+)[`"]?\s*\(([\s\S]*?)\)\s*SELECT\s+([\s\S]*?)\s+FROM\s+[`"]?(\w+)[`"]?$/iu;
const REBUILD_DROP = /^DROP\s+TABLE\s+[`"]?(\w+)[`"]?$/iu;
const REBUILD_RENAME = /^ALTER\s+TABLE\s+[`"]?__new_(\w+)[`"]?\s+RENAME\s+TO\s+[`"]?(\w+)[`"]?$/iu;

/** A line inside `CREATE TABLE (...)` that declares a column rather than a constraint. */
const COLUMN_DEFINITION = /^[`"](\w+)[`"]\s+(.*)$/su;
const DECLARED_NOT_NULL = /\bNOT\s+NULL\b/iu;
const DECLARED_DEFAULT = /\bDEFAULT\b/iu;

/**
 * Migrations that already violated spec 24's additivity policy when this check
 * was introduced. Frozen baseline — the point is to stop new ones, not to
 * rewrite applied history. Never add to this list: an OTA rollback restores code
 * only, so old code meets a forward schema and fails every query touching a
 * rebuilt table. `scripts/update.sh` snapshots the database before migrating to
 * survive exactly that, but the snapshot costs every write made during the
 * update window, which is a real price rather than a free undo.
 *
 * The one rebuild that needs no exemption is the column-preserving kind: if the
 * rebuilt table keeps every prior column at its prior-or-wider nullability,
 * copies each one across, and adds only nullable or defaulted columns, then
 * rolled-back code reads and writes it exactly as before. That shape is
 * recognised below rather than listed here — three of the four entries would now
 * clear it, but the baseline stays frozen so the list keeps meaning "predates
 * the check" rather than "was re-judged by it".
 */
const GRANDFATHERED: readonly string[] = [
  '0007_flashy_golden_guardian.sql',
  '0009_bored_silhouette.sql',
  '0014_thankful_blink.sql',
  '0016_perpetual_pepper_potts.sql',
];

interface SnapshotColumn {
  readonly name: string;
  readonly notNull: boolean;
  readonly default?: unknown;
}

interface SnapshotTable {
  readonly name: string;
  readonly columns: Record<string, SnapshotColumn>;
}

type SnapshotTables = Record<string, SnapshotTable>;

interface DeclaredColumn {
  readonly notNull: boolean;
  readonly hasDefault: boolean;
}

interface Rebuild {
  readonly table: string;
  readonly body: string;
  readonly copiedInto: readonly string[];
  readonly copiedFrom: readonly string[];
  readonly source: string;
}

/**
 * Split on `separator` at parenthesis depth 0, outside quoted text. Naive
 * splitting breaks on the commas inside `CHECK("t"."status" in ('a', 'b'))`.
 */
function splitTopLevel(text: string, separator: ';' | ','): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let quote: string | null = null;

  for (const char of text) {
    if (quote !== null) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
    } else if (char === separator && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);

  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function unquote(identifier: string): string {
  return identifier.replaceAll(/[`"]/gu, '').trim();
}

function identifierList(list: string): string[] {
  return splitTopLevel(list, ',').map(unquote);
}

/** Columns declared by the body of a `CREATE TABLE (...)`, ignoring constraint lines. */
function declaredColumns(body: string): Map<string, DeclaredColumn> {
  const columns = new Map<string, DeclaredColumn>();

  for (const line of splitTopLevel(body, ',')) {
    const match = COLUMN_DEFINITION.exec(line);
    if (match === null) continue;
    const rest = match[2] ?? '';
    columns.set(match[1] ?? '', {
      notNull: DECLARED_NOT_NULL.test(rest),
      hasDefault: DECLARED_DEFAULT.test(rest),
    });
  }

  return columns;
}

/**
 * Group the statements into well-formed rebuilds, returning everything left over
 * so the caller can hold the remainder to the raw policy.
 */
function collectRebuilds(statements: readonly string[]): {
  rebuilds: Rebuild[];
  residual: string[];
} {
  const creates = new Map<string, string[]>();
  const copies = new Map<string, string[]>();
  const drops = new Map<string, string[]>();
  const renames = new Map<string, string[]>();

  const record = (into: Map<string, string[]>, table: string, statement: string): void => {
    into.set(table, [...(into.get(table) ?? []), statement]);
  };

  for (const statement of statements) {
    const create = REBUILD_CREATE.exec(statement);
    if (create !== null) {
      record(creates, create[1] ?? '', statement);
      continue;
    }
    const copy = REBUILD_COPY.exec(statement);
    if (copy !== null) {
      record(copies, copy[1] ?? '', statement);
      continue;
    }
    const drop = REBUILD_DROP.exec(statement);
    if (drop !== null) {
      record(drops, drop[1] ?? '', statement);
      continue;
    }
    const rename = REBUILD_RENAME.exec(statement);
    if (rename !== null && unquote(rename[2] ?? '') === (rename[1] ?? '')) {
      record(renames, rename[1] ?? '', statement);
    }
  }

  const rebuilds: Rebuild[] = [];
  const consumed = new Set<string>();

  for (const [table, create] of creates) {
    const copy = copies.get(table) ?? [];
    const drop = drops.get(table) ?? [];
    const rename = renames.get(table) ?? [];
    if (create.length !== 1 || copy.length !== 1 || drop.length !== 1 || rename.length !== 1) {
      continue;
    }

    const created = REBUILD_CREATE.exec(create[0] ?? '');
    const copied = REBUILD_COPY.exec(copy[0] ?? '');
    if (created === null || copied === null) continue;

    rebuilds.push({
      table,
      body: created[2] ?? '',
      copiedInto: identifierList(copied[2] ?? ''),
      copiedFrom: identifierList(copied[3] ?? ''),
      source: unquote(copied[4] ?? ''),
    });
    for (const statement of [...create, ...copy, ...drop, ...rename]) consumed.add(statement);
  }

  return {
    rebuilds,
    residual: statements.filter((statement) => !consumed.has(statement)),
  };
}

/**
 * Why this rebuild is not safe for rolled-back code, measured against the schema
 * as it stood before the migration. Empty means every prior column survived,
 * kept its data and its nullability, and anything new can be omitted by an
 * `INSERT` that predates it.
 */
function rebuildViolations(rebuild: Rebuild, priorTables: SnapshotTables): string[] {
  const violations: string[] = [];
  const prior = priorTables[rebuild.table];

  if (prior === undefined) {
    return [`rebuilds \`${rebuild.table}\`, which the previous snapshot does not describe`];
  }
  if (rebuild.source !== rebuild.table) {
    violations.push(`copies \`${rebuild.table}\` from \`${rebuild.source}\` instead of itself`);
  }

  const rebuilt = declaredColumns(rebuild.body);

  for (const [name, column] of Object.entries(prior.columns)) {
    const kept = rebuilt.get(name);
    if (kept === undefined) {
      violations.push(`drops or renames \`${rebuild.table}\`.\`${name}\``);
      continue;
    }
    if (kept.notNull && !column.notNull) {
      violations.push(`narrows \`${rebuild.table}\`.\`${name}\` to NOT NULL`);
    }
    if (!rebuild.copiedInto.includes(name) || !rebuild.copiedFrom.includes(name)) {
      violations.push(`does not copy \`${rebuild.table}\`.\`${name}\` into the rebuilt table`);
    }
  }

  for (const [name, column] of rebuilt) {
    if (name in prior.columns) continue;
    if (column.notNull && !column.hasDefault) {
      violations.push(`adds NOT NULL column \`${rebuild.table}\`.\`${name}\` with no default`);
    }
  }

  return violations;
}

/**
 * Every way `sql` breaks the additivity policy. A migration is clean when it
 * contains no irreversible statement at all, or when each one belongs to a
 * well-formed, column-preserving table rebuild.
 */
function additivityViolations(sql: string, priorTables: SnapshotTables): string[] {
  const statements = splitTopLevel(sql.replaceAll(BREAKPOINT, ''), ';');
  const { rebuilds, residual } = collectRebuilds(statements);

  const violations = residual
    .filter((statement) => IRREVERSIBLE.test(statement))
    .map((statement) => `${statement.replaceAll(/\s+/gu, ' ')} is not part of a table rebuild`);

  for (const rebuild of rebuilds) {
    violations.push(...rebuildViolations(rebuild, priorTables));
  }

  return violations;
}

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

/**
 * The schema as it stood before `migration` ran. drizzle-kit writes one snapshot
 * per migration index describing the state *after* it, so the prior state is the
 * snapshot one index back.
 */
function priorSnapshot(migration: string): SnapshotTables {
  const index = Number.parseInt(migration.slice(0, 4), 10);
  if (!Number.isFinite(index) || index === 0) return {};

  const file = join(MIGRATIONS, 'meta', `${String(index - 1).padStart(4, '0')}_snapshot.json`);
  if (!existsSync(file)) return {};

  const snapshot = JSON.parse(readFileSync(file, 'utf8')) as { tables?: SnapshotTables };
  return snapshot.tables ?? {};
}

describe('migration additivity policy (spec 24)', () => {
  it('adds no new irreversible migration', () => {
    const offenders = migrationFiles()
      .filter((name) => !GRANDFATHERED.includes(name))
      .flatMap((name) =>
        additivityViolations(
          readFileSync(join(MIGRATIONS, name), 'utf8'),
          priorSnapshot(name),
        ).map((violation) => `${name}: ${violation}`),
      );

    expect(
      offenders,
      'A rollback restores code but never un-applies a migration. Add columns with defaults instead of dropping or renaming; a table rebuild is only allowed when it keeps every prior column, copies it across and widens nothing but constraints — see docs/specs/24-ota.md -> Migration Safety.',
    ).toEqual([]);
  });

  it('keeps the grandfathered baseline honest', () => {
    const present = new Set(migrationFiles());

    // A stale entry would silently widen the exemption for a future migration
    // that happens to reuse the name.
    expect(GRANDFATHERED.filter((name) => !present.has(name))).toEqual([]);
    // And each listed file must still actually contain the statements the
    // baseline was drawn around, or it should simply be removed from the list.
    // Deliberately the raw regex: the list records what the original check
    // flagged, so it must not be silently re-scoped by the refinement below.
    expect(
      GRANDFATHERED.filter(
        (name) => !IRREVERSIBLE.test(readFileSync(join(MIGRATIONS, name), 'utf8')),
      ),
    ).toEqual([]);
  });
});

/**
 * The schema the fixtures below rebuild: one NOT NULL key and one nullable
 * column, which between them exercise both nullability directions.
 */
const PRIOR_TABLES: SnapshotTables = {
  widgets: {
    name: 'widgets',
    columns: {
      id: { name: 'id', notNull: true },
      label: { name: 'label', notNull: false },
    },
  },
};

function rebuildSql(columns: string, copied = '"id", "label"'): string {
  return [
    'PRAGMA foreign_keys=OFF;',
    `CREATE TABLE \`__new_widgets\` (${columns});`,
    `INSERT INTO \`__new_widgets\`(${copied}) SELECT ${copied} FROM \`widgets\`;`,
    'DROP TABLE `widgets`;',
    'ALTER TABLE `__new_widgets` RENAME TO `widgets`;',
    'PRAGMA foreign_keys=ON;',
  ].join(`${BREAKPOINT}\n`);
}

describe('constraint-widening rebuild detection', () => {
  it('accepts a rebuild that keeps every column and only widens a CHECK', () => {
    const sql = rebuildSql(
      '`id` text PRIMARY KEY NOT NULL, `label` text, ' +
        `CONSTRAINT "widgets_label_check" CHECK("__new_widgets"."label" is null or "__new_widgets"."label" in ('a', 'b', 'c'))`,
    );

    expect(
      additivityViolations(sql, PRIOR_TABLES),
      'A column-preserving rebuild is invisible to rolled-back code.',
    ).toEqual([]);
  });

  it('accepts a rebuild that adds a NOT NULL column carrying a default', () => {
    const sql = rebuildSql(
      "`id` text PRIMARY KEY NOT NULL, `label` text, `kind` text DEFAULT 'plain' NOT NULL",
    );

    expect(additivityViolations(sql, PRIOR_TABLES)).toEqual([]);
  });

  it('accepts a rebuild that relaxes a NOT NULL column to nullable', () => {
    const sql = rebuildSql('`id` text PRIMARY KEY, `label` text');

    expect(additivityViolations(sql, PRIOR_TABLES)).toEqual([]);
  });

  it('rejects a rebuild that drops a column', () => {
    const sql = rebuildSql('`id` text PRIMARY KEY NOT NULL', '"id"');

    expect(
      additivityViolations(sql, PRIOR_TABLES),
      'Old code still SELECTs the dropped column.',
    ).toEqual(['drops or renames `widgets`.`label`']);
  });

  it('rejects a rebuild that renames a column', () => {
    const sql = [
      'CREATE TABLE `__new_widgets` (`id` text PRIMARY KEY NOT NULL, `caption` text);',
      'INSERT INTO `__new_widgets`("id", "caption") SELECT "id", "label" FROM `widgets`;',
      'DROP TABLE `widgets`;',
      'ALTER TABLE `__new_widgets` RENAME TO `widgets`;',
    ].join(`${BREAKPOINT}\n`);

    expect(
      additivityViolations(sql, PRIOR_TABLES),
      'A rename is a drop as far as the previous release is concerned.',
    ).toEqual(['drops or renames `widgets`.`label`']);
  });

  it('rejects a rebuild that adds a NOT NULL column with no default', () => {
    const sql = rebuildSql('`id` text PRIMARY KEY NOT NULL, `label` text, `kind` text NOT NULL');

    expect(
      additivityViolations(sql, PRIOR_TABLES),
      'Rolled-back INSERTs omit the new column and would fail the constraint.',
    ).toEqual(['adds NOT NULL column `widgets`.`kind` with no default']);
  });

  it('rejects a rebuild that narrows a nullable column to NOT NULL', () => {
    const sql = rebuildSql('`id` text PRIMARY KEY NOT NULL, `label` text NOT NULL');

    expect(additivityViolations(sql, PRIOR_TABLES)).toEqual([
      'narrows `widgets`.`label` to NOT NULL',
    ]);
  });

  it('rejects a rebuild that leaves a surviving column out of the copy', () => {
    const sql = rebuildSql('`id` text PRIMARY KEY NOT NULL, `label` text', '"id"');

    expect(
      additivityViolations(sql, PRIOR_TABLES),
      'The column survives but its rows do not.',
    ).toEqual(['does not copy `widgets`.`label` into the rebuilt table']);
  });

  it('rejects a rebuild whose rows are never copied across', () => {
    const sql = [
      'CREATE TABLE `__new_widgets` (`id` text PRIMARY KEY NOT NULL, `label` text);',
      'DROP TABLE `widgets`;',
      'ALTER TABLE `__new_widgets` RENAME TO `widgets`;',
    ].join(`${BREAKPOINT}\n`);

    expect(additivityViolations(sql, PRIOR_TABLES)).toEqual([
      'DROP TABLE `widgets` is not part of a table rebuild',
      'ALTER TABLE `__new_widgets` RENAME TO `widgets` is not part of a table rebuild',
    ]);
  });

  it('rejects a bare DROP TABLE outside the recreate pattern', () => {
    expect(additivityViolations('DROP TABLE `widgets`;', PRIOR_TABLES)).toEqual([
      'DROP TABLE `widgets` is not part of a table rebuild',
    ]);
  });

  it('rejects a bare RENAME TO outside the recreate pattern', () => {
    expect(additivityViolations('ALTER TABLE `widgets` RENAME TO `gadgets`;', PRIOR_TABLES)).toEqual(
      ['ALTER TABLE `widgets` RENAME TO `gadgets` is not part of a table rebuild'],
    );
  });

  it('rejects a bare RENAME COLUMN outside the recreate pattern', () => {
    expect(
      additivityViolations('ALTER TABLE `widgets` RENAME COLUMN `label` TO `caption`;', PRIOR_TABLES),
    ).toEqual(['ALTER TABLE `widgets` RENAME COLUMN `label` TO `caption` is not part of a table rebuild']);
  });

  it('accepts a purely additive migration', () => {
    expect(additivityViolations('ALTER TABLE `widgets` ADD `kind` text;', PRIOR_TABLES)).toEqual([]);
  });

  it('rejects a rebuild of a table the previous snapshot does not describe', () => {
    expect(additivityViolations(rebuildSql('`id` text PRIMARY KEY NOT NULL, `label` text'), {})).toEqual(
      ['rebuilds `widgets`, which the previous snapshot does not describe'],
    );
  });
});
