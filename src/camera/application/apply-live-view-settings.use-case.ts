import { Injectable } from "@nestjs/common";

import { LiveViewPolicyApplyError } from "../domain/errors/live-view-policy-apply.error";
import { ReconcileLiveViewSettingsJobUseCase } from "./reconcile-live-view-settings-job.use-case";

export interface ApplyLiveViewSettingsResult {
  readonly kind: "restart-dispatched" | "restart-required" | "pending";
}

/** Starts or resumes the durable settings job claimed by the interface layer. */
@Injectable()
export class ApplyLiveViewSettingsUseCase {
  constructor(
    private readonly reconcile: ReconcileLiveViewSettingsJobUseCase,
  ) {}

  async execute(jobId: string): Promise<ApplyLiveViewSettingsResult> {
    const outcome = await this.reconcile.execute(jobId);
    switch (outcome.kind) {
      case "pending":
        return outcome;
      case "resumed":
        return { kind: "restart-dispatched" };
      case "succeeded":
        // Stub mode activates and reconciles the committed generation in the
        // current process; callers still observe the same dispatch receipt.
        return { kind: "restart-dispatched" };
      case "restart-required":
        return outcome;
      case "failed":
        throw new LiveViewPolicyApplyError();
    }
  }
}
