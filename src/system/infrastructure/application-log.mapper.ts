import { ApplicationLogUnavailableError } from '../domain/errors/application-log-unavailable.error';

export const REDACTED_APPLICATION_LOG_VALUE = '[REDACTED]';

export interface SanitizedApplicationLogLines {
  readonly lines: readonly string[];
  readonly truncatedByByteLimit: boolean;
}

const SECRET_KEY_PATTERN = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|CREDENTIALS?|PRIVATE_KEY|AUTHORIZATION)(?:_|$)/iu;
const SECRET_METADATA_KEY_PATTERN = /(?:_VERSION|_FILE|_PATH|_ENABLED)$/u;
// eslint-disable-next-line no-control-regex -- CSI sequences begin with ESC.
const ANSI_CSI_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/gu;
// eslint-disable-next-line no-control-regex -- OSC sequences are terminated by BEL or ESC backslash.
const ANSI_OSC_PATTERN = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/gu;
const AUTHORIZATION_PATTERN = /(Authorization\s*:\s*(?:Bearer|Basic)\s+)\S+/giu;
const URL_PATTERN = /\b[a-z][a-z\d+.-]*:\/\/[^\s'"<>]+/giu;
const SENSITIVE_QUERY_KEY_PATTERN = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|CREDENTIALS?|PRIVATE_KEY|AUTHORIZATION|API_KEY|KEY)(?:_|$)|^ACCESS_TOKEN$/iu;
const TELEGRAM_BOT_TOKEN_PATTERN = /\b\d{6,}:[A-Za-z\d_-]{20,}\b/gu;
const ENCODED_REDACTION_MARKER = '%5BREDACTED%5D';

export function sanitizeAndBoundApplicationLogLines(
  rawLines: readonly Buffer[],
  environment: Readonly<Record<string, string | undefined>>,
  maxBytes: number,
): SanitizedApplicationLogLines {
  const secretValues = configuredSecretValues(environment);
  const sanitized = rawLines.map((line) => sanitizeLine(line.toString('utf8'), secretValues));
  return keepNewestCompleteLines(sanitized, maxBytes);
}

function configuredSecretValues(
  environment: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  const secretValues: string[] = [];

  for (const [key, value] of Object.entries(environment)) {
    if (!SECRET_KEY_PATTERN.test(key) || SECRET_METADATA_KEY_PATTERN.test(key) || !value) {
      continue;
    }

    if (Buffer.byteLength(value, 'utf8') < 8) {
      throw new ApplicationLogUnavailableError('sanitization-unsafe');
    }

    secretValues.push(value);
  }

  return secretValues.sort((left, right) => right.length - left.length);
}

function sanitizeLine(line: string, secretValues: readonly string[]): string {
  const withoutAnsi = line.replace(ANSI_CSI_PATTERN, '').replace(ANSI_OSC_PATTERN, '');
  const withoutAuthorization = withoutAnsi.replace(
    AUTHORIZATION_PATTERN,
    `$1${REDACTED_APPLICATION_LOG_VALUE}`,
  );
  const withoutUrlCredentials = withoutAuthorization.replace(URL_PATTERN, redactUrlCredentials);
  const withoutBotTokens = withoutUrlCredentials.replace(
    TELEGRAM_BOT_TOKEN_PATTERN,
    REDACTED_APPLICATION_LOG_VALUE,
  );

  return secretValues.reduce(
    (sanitized, secretValue) => sanitized.split(secretValue).join(REDACTED_APPLICATION_LOG_VALUE),
    withoutBotTokens,
  );
}

function redactUrlCredentials(candidate: string): string {
  let parsed: URL;

  try {
    parsed = new URL(candidate);
  } catch {
    return candidate;
  }

  if (parsed.username) {
    parsed.username = REDACTED_APPLICATION_LOG_VALUE;
  }
  if (parsed.password) {
    parsed.password = REDACTED_APPLICATION_LOG_VALUE;
  }
  for (const [key] of parsed.searchParams) {
    if (SENSITIVE_QUERY_KEY_PATTERN.test(key)) {
      parsed.searchParams.set(key, REDACTED_APPLICATION_LOG_VALUE);
    }
  }

  return parsed.toString().replaceAll(ENCODED_REDACTION_MARKER, REDACTED_APPLICATION_LOG_VALUE);
}

function keepNewestCompleteLines(
  lines: readonly string[],
  maxBytes: number,
): SanitizedApplicationLogLines {
  const retained: string[] = [];
  let usedBytes = 0;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;

    if (lineBytes > maxBytes && retained.length === 0) {
      throw new ApplicationLogUnavailableError('snapshot-too-large');
    }
    if (usedBytes + lineBytes > maxBytes) {
      return { lines: retained.reverse(), truncatedByByteLimit: true };
    }

    retained.push(line);
    usedBytes += lineBytes;
  }

  return { lines: retained.reverse(), truncatedByByteLimit: false };
}
