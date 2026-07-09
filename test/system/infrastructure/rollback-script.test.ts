import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function writeMetaBody(script: string): string {
  const match = /write_meta\(\) \{\n([\s\S]*?)\n\}/.exec(script);
  expect(match).not.toBeNull();
  return match?.[1] ?? '';
}

describe('rollback.sh write_meta', () => {
  it('SQL-escapes key and value before sqlite3 interpolation', () => {
    const script = readFileSync(resolve('scripts/rollback.sh'), 'utf8');
    const body = writeMetaBody(script);

    expect(body).toContain(`local esc_key=\${key//"'"/"''"}`);
    expect(body).toContain(`local esc_value=\${value//"'"/"''"}`);
    expect(body).toContain("VALUES('$esc_key', '$esc_value')");
    expect(body).not.toContain("VALUES('$key', '$value')");
  });
});
