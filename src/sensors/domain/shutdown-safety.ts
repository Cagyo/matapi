export const SENSOR_SHUTDOWN_TIMEOUT_MS = 5_000;

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/gi;
const TRAILING_URL_PUNCTUATION = /[),.;:]+$/;

/** Wait for a third-party cleanup operation without allowing it to stall shutdown. */
export async function completeWithinShutdownTimeout(
  operation: Promise<unknown>,
  timeoutMs = SENSOR_SHUTDOWN_TIMEOUT_MS,
): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** Remove URL user-info, paths, and query strings before writing external errors to logs. */
export function redactSensitiveUrls(text: string): string {
  return text.replace(URL_PATTERN, (value) => {
    const trimmed = value.replace(TRAILING_URL_PUNCTUATION, '');
    const suffix = value.slice(trimmed.length);
    try {
      const url = new URL(trimmed);
      return `${url.protocol}//${url.host}${suffix}`;
    } catch {
      return `[redacted-url]${suffix}`;
    }
  });
}

export function safeErrorMessage(error: unknown): string {
  return redactSensitiveUrls(error instanceof Error ? error.message : 'Unknown error');
}

export function safeBrokerUrl(brokerUrl: string): string {
  return redactSensitiveUrls(brokerUrl);
}
