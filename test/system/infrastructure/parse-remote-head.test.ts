import { describe, expect, it } from 'vitest';
import { parseRemoteHead } from '../../../src/system/infrastructure/shell-ota.adapter';

describe('parseRemoteHead', () => {
  it('extracts the branch from "origin/master"', () => {
    expect(parseRemoteHead('origin/master\n')).toBe('master');
  });

  it('extracts the branch from "origin/main"', () => {
    expect(parseRemoteHead('origin/main')).toBe('main');
  });

  it('handles branch names containing slashes', () => {
    expect(parseRemoteHead('origin/release/v2')).toBe('release/v2');
  });

  it('returns null for empty or unexpected output', () => {
    expect(parseRemoteHead('')).toBeNull();
    expect(parseRemoteHead('origin/')).toBeNull();
    expect(
      parseRemoteHead(
        'fatal: ref refs/remotes/origin/HEAD is not a symbolic ref',
      ),
    ).toBeNull();
  });
});
