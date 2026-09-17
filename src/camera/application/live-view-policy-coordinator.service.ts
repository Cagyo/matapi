import { Injectable } from "@nestjs/common";
import { LiveViewSettingsBusyError } from "../domain/errors/live-view-settings-busy.error";

export type LiveViewPolicyMutationKind = "settings" | "rtsp-state";

export interface LiveViewPolicyMutationLease {
  markRestartPending(): void;
}

/** One fail-fast process-local lease shared by every live-view policy writer. */
@Injectable()
export class LiveViewPolicyCoordinatorService {
  private activeKind: LiveViewPolicyMutationKind | null = null;
  private restartPending = false;

  async run<T>(
    kind: LiveViewPolicyMutationKind,
    operation: (lease: LiveViewPolicyMutationLease) => Promise<T>,
  ): Promise<T> {
    if (this.activeKind !== null || this.restartPending) {
      throw new LiveViewSettingsBusyError();
    }

    this.activeKind = kind;
    let leaseActive = true;
    const lease: LiveViewPolicyMutationLease = {
      markRestartPending: () => {
        if (leaseActive) this.restartPending = true;
      },
    };

    try {
      return await operation(lease);
    } finally {
      leaseActive = false;
      this.activeKind = null;
    }
  }

  isRestartPending(): boolean {
    return this.restartPending;
  }
}
