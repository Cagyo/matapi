import type { OtaFailureCode } from "../domain/ota-failure";
import {
  SignedEnvelopeVerificationError,
  type SignedEnvelopeVerifierPort,
} from "../domain/ports/signed-envelope-verifier.port";
import {
  verifySignedEnvelope,
  type ManifestPolicy,
  type VerifiedEnvelope,
} from "../domain/signed-manifest";
import { loadActiveKeys } from "./ed25519-keyring.loader";

function classify(message: string): OtaFailureCode {
  if (message.includes("96 KiB")) return "envelope-too-large";
  if (message.includes("signature")) return "signature-invalid";
  if (message.includes("expired")) return "metadata-expired";
  if (
    message.includes("target") ||
    message.includes("artifact URL") ||
    message.includes("origin")
  ) {
    return "target-incompatible";
  }
  if (message.includes("runtime") || message.includes("packageManager"))
    return "runtime-incompatible";
  if (message.includes("envelope") || message.includes("Base64"))
    return "envelope-malformed";
  return "schema-invalid";
}

export class Ed25519EnvelopeVerifierAdapter implements SignedEnvelopeVerifierPort {
  constructor(private readonly trustDirectory: string) {}

  verify(
    bytes: Uint8Array,
    policy: ManifestPolicy,
    checkTime: Date,
  ): VerifiedEnvelope {
    const keys = loadActiveKeys(this.trustDirectory);
    if (keys.length === 0)
      throw new SignedEnvelopeVerificationError("trust-key-missing");
    try {
      return verifySignedEnvelope(bytes, keys, policy, checkTime);
    } catch (error) {
      throw new SignedEnvelopeVerificationError(
        classify(error instanceof Error ? error.message : ""),
      );
    }
  }
}
