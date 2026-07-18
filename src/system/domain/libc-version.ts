const MAX_LIBC_VERSION_BYTES = 32;
const DOTTED_DECIMAL = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))*$/;

export function parseLibcVersion(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > MAX_LIBC_VERSION_BYTES ||
    Buffer.byteLength(value, "utf8") !== value.length ||
    !DOTTED_DECIMAL.test(value)
  ) {
    throw new Error("libc version must be a canonical dotted decimal");
  }
  return value;
}

export function compareLibcVersions(left: string, right: string): number {
  const leftParts = parseLibcVersion(left).split(".").map(BigInt);
  const rightParts = parseLibcVersion(right).split(".").map(BigInt);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? 0n;
    const rightPart = rightParts[index] ?? 0n;
    if (leftPart < rightPart) return -1;
    if (leftPart > rightPart) return 1;
  }
  return 0;
}
