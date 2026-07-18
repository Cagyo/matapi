const JSON_WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
const CANONICAL_BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

function invalid(message: string): never {
  throw new Error(`invalid strict JSON: ${message}`);
}

class StrictJsonParser {
  private index = 0;
  private depth = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.source.length) invalid("trailing content");
    return value;
  }

  private parseValue(): unknown {
    this.skipWhitespace();
    const character = this.source[this.index];
    if (character === "{") return this.parseObject();
    if (character === "[") return this.parseArray();
    if (character === '"') return this.parseString();
    if (character === "t") return this.parseLiteral("true", true);
    if (character === "f") return this.parseLiteral("false", false);
    if (character === "n") return this.parseLiteral("null", null);
    if (character === "-" || isDigit(character)) return this.parseNumber();
    return invalid("malformed value");
  }

  private parseObject(): Record<string, unknown> {
    this.enterContainer();
    this.index += 1;
    this.skipWhitespace();
    const result: Record<string, unknown> = {};
    const keys = new Set<string>();
    if (this.consume("}")) {
      this.depth -= 1;
      return result;
    }

    while (true) {
      this.skipWhitespace();
      if (this.source[this.index] !== '"')
        invalid("object key must be a string");
      const key = this.parseString();
      if (keys.has(key)) invalid("duplicate object key");
      keys.add(key);
      this.skipWhitespace();
      if (!this.consume(":")) invalid("object key must be followed by a colon");
      const value = this.parseValue();
      Object.defineProperty(result, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      this.skipWhitespace();
      if (this.consume("}")) {
        this.depth -= 1;
        return result;
      }
      if (!this.consume(",")) invalid("object entries must be comma-separated");
    }
  }

  private parseArray(): unknown[] {
    this.enterContainer();
    this.index += 1;
    this.skipWhitespace();
    const result: unknown[] = [];
    if (this.consume("]")) {
      this.depth -= 1;
      return result;
    }
    while (true) {
      result.push(this.parseValue());
      this.skipWhitespace();
      if (this.consume("]")) {
        this.depth -= 1;
        return result;
      }
      if (!this.consume(",")) invalid("array entries must be comma-separated");
    }
  }

  private parseString(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.source.length) {
      const code = this.source.charCodeAt(this.index);
      if (code === 0x22) {
        this.index += 1;
        try {
          return JSON.parse(this.source.slice(start, this.index)) as string;
        } catch {
          return invalid("malformed string");
        }
      }
      if (code < 0x20) invalid("unescaped control character in string");
      if (code === 0x5c) {
        this.index += 1;
        const escape = this.source[this.index];
        if (escape === "u") {
          if (
            !/^[0-9a-fA-F]{4}$/.test(
              this.source.slice(this.index + 1, this.index + 5),
            )
          ) {
            invalid("malformed Unicode escape");
          }
          this.index += 5;
          continue;
        }
        if (!['"', "\\", "/", "b", "f", "n", "r", "t"].includes(escape ?? "")) {
          invalid("malformed string escape");
        }
      }
      this.index += 1;
    }
    return invalid("unterminated string");
  }

  private parseNumber(): number {
    const token = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      this.source.slice(this.index),
    )?.[0];
    if (!token) return invalid("malformed number");
    this.index += token.length;
    return parseExactSafeInteger(token);
  }

  private parseLiteral<T>(token: string, value: T): T {
    if (this.source.slice(this.index, this.index + token.length) !== token) {
      invalid("malformed literal");
    }
    this.index += token.length;
    return value;
  }

  private skipWhitespace(): void {
    while (JSON_WHITESPACE.has(this.source[this.index] ?? "")) this.index += 1;
  }

  private consume(character: string): boolean {
    if (this.source[this.index] !== character) return false;
    this.index += 1;
    return true;
  }

  private enterContainer(): void {
    if (this.depth >= 64) invalid("nesting exceeds 64 levels");
    this.depth += 1;
  }
}

function parseExactSafeInteger(token: string): number {
  const parts = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (parts === null) return invalid("malformed number");

  const fraction = parts[3] ?? "";
  const coefficient = `${parts[2]}${fraction}`.replace(/^0+/, "") || "0";
  if (coefficient === "0") return Number(token);

  const exponentText = parts[4] ?? "0";
  const exponentSign = exponentText.startsWith("-") ? -1 : 1;
  const exponentMagnitude = exponentText
    .replace(/^[+-]/, "")
    .replace(/^0+/, "");
  if (exponentMagnitude.length > 6) {
    return invalid(
      exponentSign < 0
        ? "numeric literal is not an exact integer"
        : "numeric integer literal exceeds the safe range",
    );
  }
  const exponent =
    exponentSign *
    Number(exponentMagnitude.length === 0 ? "0" : exponentMagnitude);
  const decimalPlaces = fraction.length - exponent;

  let integerDigits: string;
  if (decimalPlaces > 0) {
    if (
      decimalPlaces > coefficient.length ||
      !coefficient.endsWith("0".repeat(decimalPlaces))
    ) {
      return invalid("numeric literal is not an exact integer");
    }
    integerDigits = coefficient.slice(0, coefficient.length - decimalPlaces);
  } else {
    const appendedZeros = -decimalPlaces;
    if (coefficient.length + appendedZeros > 16) {
      return invalid("numeric integer literal exceeds the safe range");
    }
    integerDigits = coefficient + "0".repeat(appendedZeros);
  }

  const magnitude = BigInt(integerDigits || "0");
  if (magnitude > MAX_SAFE_INTEGER) {
    return invalid("numeric integer literal exceeds the safe range");
  }
  return Number(token);
}

function isDigit(character: string | undefined): boolean {
  return character !== undefined && character >= "0" && character <= "9";
}

export function parseStrictJson(input: string | Uint8Array): unknown {
  let source: string;
  try {
    source =
      typeof input === "string"
        ? input
        : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
            input,
          );
  } catch {
    return invalid("input is not valid UTF-8");
  }
  if (source.startsWith("\uFEFF")) invalid("input must not contain a BOM");
  return new StrictJsonParser(source).parse();
}

export function decodeCanonicalBase64(value: unknown, label: string): Buffer {
  if (
    typeof value !== "string" ||
    value.length % 4 !== 0 ||
    !CANONICAL_BASE64.test(value)
  ) {
    throw new Error(`${label} must be canonical padded RFC 4648 Base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error(`${label} must be canonical padded RFC 4648 Base64`);
  }
  return decoded;
}
