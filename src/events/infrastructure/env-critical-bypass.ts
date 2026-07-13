/**
 * Critical alarms unconditionally bypass quiet hours — this is now an invariant
 * of the notification policy, not a configurable flag. The old
 * `CRITICAL_IGNORES_QUIET_HOURS` env var is no longer read anywhere. To avoid a
 * silent behavior change for a deployment that set it `false` (which would have
 * suppressed critical alarms during quiet hours), surface a one-time warning at
 * boot when the variable is still present.
 *
 * The message never echoes the flag's value or any secret/ID — it only notes
 * that the variable is set.
 */
export function criticalBypassDeprecationWarning(
  env: NodeJS.ProcessEnv,
): string | null {
  if (env.CRITICAL_IGNORES_QUIET_HOURS === undefined) return null;
  return (
    'CRITICAL_IGNORES_QUIET_HOURS is set but no longer honored: ' +
    'critical alarms always bypass quiet hours. Remove the variable from your ' +
    'environment.'
  );
}
