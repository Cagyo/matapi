import { createHash } from "node:crypto";
import type { ArchiveArtifactKind } from "./archive-artifact.entity";

const MAX_KEY_VALUE_BYTES = 124;
const PREFIX = "a1";

export interface ArchiveAppPropertiesInput {
  installationId: string;
  generationId: string;
  kind: ArchiveArtifactKind;
  sourceFingerprint: string;
  sha256: string;
  sourceTimeMs: number;
  schemaVersion: number;
}

export type ArchiveAppPropertyKey =
  | "a1v"
  | "a1i"
  | "a1g"
  | "a1k"
  | "a1f"
  | "a1s"
  | "a1t";

export type ArchiveAppProperties = Readonly<
  Record<ArchiveAppPropertyKey, string>
>;

export function encodeArchiveAppProperties(
  input: ArchiveAppPropertiesInput,
): ArchiveAppProperties {
  const sourceTimeMs = String(input.sourceTimeMs);
  const properties: Record<ArchiveAppPropertyKey, string> = {
    [`${PREFIX}v`]: String(input.schemaVersion),
    [`${PREFIX}i`]: encodeBoundedValue(input.installationId, `${PREFIX}i`),
    [`${PREFIX}g`]: encodeBoundedValue(input.generationId, `${PREFIX}g`),
    [`${PREFIX}k`]: encodeBoundedValue(input.kind, `${PREFIX}k`),
    [`${PREFIX}f`]: encodeBoundedValue(input.sourceFingerprint, `${PREFIX}f`),
    [`${PREFIX}s`]: encodeBoundedValue(input.sha256, `${PREFIX}s`),
    [`${PREFIX}t`]: encodeBoundedValue(sourceTimeMs, `${PREFIX}t`),
  };
  return Object.freeze(properties);
}

export function matchesArchiveAppProperties(
  expected: ArchiveAppProperties,
  actual: Readonly<Record<string, string>>,
): boolean {
  return (Object.keys(expected) as ArchiveAppPropertyKey[]).every(
    (key) => actual[key] === expected[key],
  );
}

function encodeBoundedValue(value: unknown, key: string): string {
  const text = typeof value === "string" ? value : "";
  if (Buffer.byteLength(key + text, "utf8") <= MAX_KEY_VALUE_BYTES) {
    return text;
  }
  return `h:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}
