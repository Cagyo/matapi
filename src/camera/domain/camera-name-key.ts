/**
 * Canonical lookup key for a camera display name (spec 20). Two names that
 * differ only in surrounding whitespace, letter case, or Unicode composition
 * name the same camera, so the key — not `cameras.name` — carries uniqueness.
 *
 * Case folding can re-decompose an already-composed letter, so the key is
 * normalized again afterwards and is therefore idempotent.
 */
export function cameraNameKey(name: string): string {
  return name.trim().normalize('NFC').toLowerCase().normalize('NFC');
}
