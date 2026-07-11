import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('dev-update.sh', () => {
  it('makes uploaded source files readable by the update service account', () => {
    const script = readFileSync(resolve('scripts/dev-update.sh'), 'utf8');

    expect(script).toContain('normalize_staging_permissions()');
    expect(script).toContain('! -path "$staging/data/*"');
    expect(script).toContain('! -name ".env.*"');
    expect(script).toContain('normalize_staging_permissions');
  });
});
