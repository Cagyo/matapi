import type { OtaFailureCode } from "../ota-failure";
import type { ManifestPolicy, VerifiedEnvelope } from "../signed-manifest";

export const SIGNED_ENVELOPE_VERIFIER = Symbol("SIGNED_ENVELOPE_VERIFIER");

export class SignedEnvelopeVerificationError extends Error {
  constructor(readonly code: OtaFailureCode) {
    super(code);
    this.name = "SignedEnvelopeVerificationError";
  }
}

export interface SignedEnvelopeVerifierPort {
  verify(
    bytes: Uint8Array,
    policy: ManifestPolicy,
    checkTime: Date,
  ): VerifiedEnvelope;
}
