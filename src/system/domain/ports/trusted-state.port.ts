import type { TrustedState } from "../ota-contracts";

export type TrustedStateCommit = Omit<TrustedState, "checksum">;

export class TrustedStateLostError extends Error {
  readonly code = "trust-state-lost" as const;

  constructor() {
    super("trust-state-lost");
    this.name = "TrustedStateLostError";
  }
}

export interface TrustedStatePort {
  load(): Promise<TrustedState>;
  commit(state: TrustedStateCommit): Promise<TrustedState>;
}
