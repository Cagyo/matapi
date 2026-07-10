import { SensorDriverShutdownContext } from '../domain/ports/sensor-driver.port';

export type SensorDriverCleanupResult = 'completed' | 'cancelled' | 'failed';

/** Wait for adapter cleanup without allowing a cancelled shutdown budget to stall it. */
export function completeWithinDriverShutdownContext(
  operation: Promise<unknown>,
  context?: SensorDriverShutdownContext,
): Promise<SensorDriverCleanupResult> {
  if (!context) {
    return operation.then(
      () => 'completed',
      () => 'failed',
    );
  }

  return new Promise((resolve) => {
    let settled = false;
    const remainingMs = context.deadlineAt - Date.now();
    const finish = (result: SensorDriverCleanupResult) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      context.signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = () => finish('cancelled');
    const timeout =
      !context.signal.aborted && remainingMs > 0
        ? setTimeout(onAbort, remainingMs)
        : undefined;
    timeout?.unref?.();

    operation.then(
      () => finish('completed'),
      () => finish('failed'),
    );

    if (context.signal.aborted || remainingMs <= 0) {
      finish('cancelled');
      return;
    }

    context.signal.addEventListener('abort', onAbort, { once: true });
  });
}
