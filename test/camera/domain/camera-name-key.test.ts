import { describe, expect, it } from 'vitest';
import { cameraNameKey } from '../../../src/camera/domain/camera-name-key';

/** U+00FC — a single precomposed letter. */
const COMPOSED = 'Terrassentür';
/** U+0075 U+0308 — the same letter spelled as base plus combining diaeresis. */
const DECOMPOSED = 'Terrassentür';
/** U+212B ANGSTROM SIGN, which NFC folds onto U+00C5. */
const ANGSTROM_SIGN = 'Ångström';

describe('cameraNameKey', () => {
  it('ignores surrounding whitespace', () => {
    expect(cameraNameKey('  Front Door \n')).toBe('front door');
    expect(cameraNameKey('\tfront door')).toBe(cameraNameKey('front door '));
  });

  it('folds case', () => {
    expect(cameraNameKey('FRONT_DOOR')).toBe('front_door');
    expect(cameraNameKey('ÅNGSTRÖM')).toBe(cameraNameKey('ångström'));
  });

  it('treats composed and decomposed spellings as the same camera', () => {
    expect(COMPOSED).not.toBe(DECOMPOSED);

    expect(cameraNameKey(COMPOSED)).toBe(cameraNameKey(DECOMPOSED));
    expect(cameraNameKey(DECOMPOSED)).toBe(cameraNameKey(COMPOSED.toUpperCase()));
  });

  it('composes singleton characters before folding case', () => {
    expect(cameraNameKey(ANGSTROM_SIGN)).toBe(cameraNameKey('Ångström'));
  });

  it('returns a composed, idempotent key', () => {
    const key = cameraNameKey(` ${DECOMPOSED} `);

    expect(key).toBe(key.normalize('NFC'));
    expect(cameraNameKey(key)).toBe(key);
  });

  it('keeps distinct names distinct', () => {
    expect(cameraNameKey('front door')).not.toBe(cameraNameKey('front  door'));
    expect(cameraNameKey('front_door')).not.toBe(cameraNameKey('front-door'));
  });
});
