import { describe, expect, it } from 'vitest';
import {
  ShellSystemDepsAdapter,
  evaluateNode,
  parseAptPolicy,
  parseRcloneCheck,
  parseRcloneVersion,
  selectAptPackages,
} from '../../../src/system/infrastructure/shell-system-deps.adapter';

describe('selectAptPackages', () => {
  it('intersects yml apt lists with the upgradable allowlist', () => {
    const config = {
      node: '20',
      core: { apt: ['git', 'sqlite3', 'pigpio'] },
      motion: { apt: ['motion', 'ffmpeg'] },
      zigbee: { apt: ['mosquitto', 'mosquitto-clients'] },
    };
    expect(selectAptPackages(config)).toEqual(['motion', 'ffmpeg', 'mosquitto']);
  });

  it('excludes packages not declared in the yml', () => {
    const config = { core: { apt: ['git'] }, motion: { apt: ['ffmpeg'] } };
    expect(selectAptPackages(config)).toEqual(['ffmpeg']);
  });

  it('tolerates features without apt lists', () => {
    const config = { node: '20', uart: { 'raspi-config': ['do_serial 2'] } };
    expect(selectAptPackages(config)).toEqual([]);
  });
});

describe('parseAptPolicy', () => {
  it('detects an available upgrade', () => {
    const stdout = [
      'motion:',
      '  Installed: 4.5.1-1',
      '  Candidate: 4.6.0-1',
      '  Version table:',
    ].join('\n');
    expect(parseAptPolicy('motion', stdout)).toEqual({
      name: 'motion',
      current: '4.5.1-1',
      available: '4.6.0-1',
      kind: 'upgrade',
    });
  });

  it('reports no update when installed equals candidate', () => {
    const stdout = 'ffmpeg:\n  Installed: 7:5.1.6-0\n  Candidate: 7:5.1.6-0';
    expect(parseAptPolicy('ffmpeg', stdout)).toMatchObject({ kind: 'none' });
  });

  it('reports not-installed when Installed is (none)', () => {
    const stdout = 'mosquitto:\n  Installed: (none)\n  Candidate: 2.0.11-1';
    expect(parseAptPolicy('mosquitto', stdout)).toEqual({
      name: 'mosquitto',
      current: null,
      available: '2.0.11-1',
      kind: 'not-installed',
    });
  });
});

describe('parseRcloneVersion / parseRcloneCheck', () => {
  it('extracts the installed version', () => {
    expect(parseRcloneVersion('rclone v1.65.0\n- os/version: ...')).toBe('1.65.0');
  });

  it('detects an rclone upgrade', () => {
    const out = 'yours:  1.65.0\nlatest: 1.67.0 (released 2024-01-01)';
    expect(parseRcloneCheck('1.65.0', out)).toEqual({
      name: 'rclone',
      current: '1.65.0',
      available: '1.67.0',
      kind: 'upgrade',
    });
  });

  it('reports none when already on the latest', () => {
    const out = 'yours:  1.67.0\nlatest: 1.67.0';
    expect(parseRcloneCheck('1.67.0', out)).toMatchObject({ kind: 'none' });
  });
});

describe('evaluateNode', () => {
  it('flags a major mismatch as manual intervention', () => {
    expect(evaluateNode('22.3.0', '20')).toEqual({
      name: 'node',
      current: '22.3.0',
      available: '20.x',
      kind: 'node-major',
    });
  });

  it('reports no update within the desired major', () => {
    expect(evaluateNode('20.11.1', '20')).toMatchObject({
      name: 'node',
      kind: 'none',
    });
  });

  it('reports none when no desired major is configured', () => {
    expect(evaluateNode('20.11.1', null)).toMatchObject({ kind: 'none' });
  });
});

describe('ShellSystemDepsAdapter.check (integration / dev-host degradation)', () => {
  it('resolves with motion/ffmpeg/mosquitto/rclone/node without throwing', async () => {
    const adapter = new ShellSystemDepsAdapter();
    const result = await adapter.check();

    const names = result.deps.map((d) => d.name);
    expect(names).toContain('motion');
    expect(names).toContain('ffmpeg');
    expect(names).toContain('mosquitto');
    expect(names).toContain('rclone');
    expect(names).toContain('node');
    expect(typeof result.hasUpdates).toBe('boolean');
  }, 70_000);
});
