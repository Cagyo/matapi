/**
 * Run `fn` over `items` with at most `limit` concurrent executions. Rejections
 * propagate — callers that need per-item isolation must catch inside `fn`.
 */
export async function forEachWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const size = Math.max(1, Math.min(limit, queue.length));
  const workers = Array.from({ length: size }, async () => {
    while (queue.length > 0) {
      const item = queue.shift() as T;
      await fn(item);
    }
  });
  await Promise.all(workers);
}
