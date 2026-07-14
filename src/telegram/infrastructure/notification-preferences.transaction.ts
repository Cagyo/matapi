/**
 * Small shared boundary for the in-memory adapter's paired user/action state.
 * SQLite uses the equivalent `BEGIN IMMEDIATE` boundary in its action adapter;
 * keeping the orchestration here makes an in-memory rollback explicit rather
 * than relying on Map writes happening not to throw.
 */
export interface NotificationPreferencesTransaction {
  transaction<T>(operation: () => Promise<T>): Promise<T>;
}

export function runNotificationPreferencesTransaction<T>(
  transaction: NotificationPreferencesTransaction,
  operation: () => Promise<T>,
): Promise<T> {
  return transaction.transaction(operation);
}
