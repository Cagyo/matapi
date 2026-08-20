const FEATURE_OPERATION_FAILED = 'FEATURE_OPERATION_FAILED';
const SAFE_FAILURE_CODE = /^[A-Za-z0-9_]{1,64}$/;

/**
 * Path-free discriminator for a feature-context failure; the caller's message
 * names the operation. SQLite and Node error codes (`SQLITE_BUSY`,
 * `SQLITE_CANTOPEN`, `EACCES`) and domain error codes are safe by
 * construction; the character guard rejects anything else, which is how a code
 * carrying a database path degrades to the fixed token.
 *
 * Shared by the two services that read `FeatureQueryPort` at boot, so the
 * seeder's `onModuleInit` cannot leak the path that the readiness barrier's
 * later log carefully withholds.
 */
export function featureFailureCode(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error
    && typeof error.code === 'string'
    ? error.code
    : null;
  const candidate = code
    ?? (error instanceof Error && error.name !== 'Error' ? error.name : null);
  return candidate !== null && SAFE_FAILURE_CODE.test(candidate)
    ? candidate
    : FEATURE_OPERATION_FAILED;
}
