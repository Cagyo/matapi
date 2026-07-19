export const OTA_FAILURE_CODES = [
  "clock-unsynchronized",
  "clock-rollback",
  "network-unavailable",
  "network-timeout",
  "redirect-rejected",
  "http-status",
  "envelope-too-large",
  "envelope-malformed",
  "trust-key-missing",
  "trust-key-invalid",
  "signature-invalid",
  "metadata-rollback",
  "metadata-equivocation",
  "metadata-expired",
  "metadata-freeze",
  "schema-invalid",
  "target-incompatible",
  "runtime-incompatible",
  "disk-resource",
  "archive-integrity",
  "archive-policy",
  "dependency-sandbox",
  "dependency-install",
  "prepared-tree",
  "migration",
  "activation",
  "pm2",
  "readiness",
  "restart-loop",
  "rollback",
  "operation-in-progress",
  "trust-state-lost",
  "maintenance-required",
] as const;

export type OtaFailureCode = (typeof OTA_FAILURE_CODES)[number];

/**
 * Public OTA failures deliberately carry no diagnostics. Diagnostics belong in
 * the durable operation journal, never in values surfaced to callers.
 */
export type OtaFailure = {
  [Code in OtaFailureCode]: { code: Code };
}[OtaFailureCode];

export function isOtaFailureCode(value: unknown): value is OtaFailureCode {
  return (
    typeof value === "string" &&
    (OTA_FAILURE_CODES as readonly string[]).includes(value)
  );
}
