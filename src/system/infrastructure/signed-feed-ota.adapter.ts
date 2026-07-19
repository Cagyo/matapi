import { Inject, Injectable } from "@nestjs/common";
import { CheckForUpdatesUseCase } from "../application/check-for-updates.use-case";
import { OtaWorkflowBindingRegistry } from "../application/ota-workflow-binding.registry";
import type {
  CheckedReleaseIdentity,
  StartOperationResult,
  UpdateCheck,
} from "../domain/ota-contracts";
import {
  OTA_OPERATION_LAUNCHER,
  type OtaOperationLauncherPort,
} from "../domain/ports/ota-operation-launcher.port";
import type { OtaPort, OtaWorkflowReference } from "../domain/ports/ota.port";

const WORKFLOW_RECEIPT_ID = /^[A-Za-z0-9_-]{16}$/;

/** Keeps signed discovery and exact-identity operation launch behind one port. */
@Injectable()
export class SignedFeedOtaAdapter implements OtaPort {
  constructor(
    private readonly checks: CheckForUpdatesUseCase,
    @Inject(OTA_OPERATION_LAUNCHER)
    private readonly launcher: OtaOperationLauncherPort,
    private readonly bindings: OtaWorkflowBindingRegistry,
  ) {}

  checkForUpdates(): Promise<UpdateCheck> {
    return this.checks.execute();
  }

  async startUpdate(
    expected: CheckedReleaseIdentity,
    workflow: OtaWorkflowReference,
    signal?: AbortSignal,
  ): Promise<StartOperationResult> {
    if (!this.validWorkflowReference(workflow)) return this.rejected();
    return this.start(() => this.launcher.reserveUpdate(expected, signal), workflow, signal);
  }

  async startRollback(
    workflow: OtaWorkflowReference,
    signal?: AbortSignal,
  ): Promise<StartOperationResult> {
    if (!this.validWorkflowReference(workflow)) return this.rejected();
    return this.start(() => this.launcher.reserveRollback(signal), workflow, signal);
  }

  private async start(
    reserve: () => ReturnType<OtaOperationLauncherPort["reserveRollback"]>,
    workflow: OtaWorkflowReference,
    signal?: AbortSignal,
  ): Promise<StartOperationResult> {
    let reservation: Awaited<ReturnType<typeof reserve>>;
    try {
      reservation = await reserve();
    } catch {
      return this.rejected();
    }
    if (reservation.kind === "rejected") return reservation;
    let bound = false;
    try {
      bound = await this.bindings.bind({
        receipt: reservation.receipt,
        workflow,
      });
    } catch {
      // Binding failures are authorization failures and remain unpublished.
    }
    if (!bound) {
      await this.launcher.cancel(reservation.receipt).catch(() => false);
      return this.rejected();
    }
    // Once the durable route exists, retain it across every publication
    // outcome: the updater may have become externally visible before failure.
    try {
      return await this.launcher.publish(reservation.receipt, signal);
    } catch {
      return this.rejected();
    }
  }

  private validWorkflowReference(value: unknown): value is OtaWorkflowReference {
    if (!value || typeof value !== "object") return false;
    const reference = value as Record<string, unknown>;
    return (
      Number.isSafeInteger(reference.userId) &&
      Number.isSafeInteger(reference.chatId) &&
      typeof reference.workflowReceiptId === "string" &&
      WORKFLOW_RECEIPT_ID.test(reference.workflowReceiptId) &&
      Buffer.from(reference.workflowReceiptId, "base64url").byteLength === 12 &&
      Buffer.from(reference.workflowReceiptId, "base64url").toString(
        "base64url",
      ) === reference.workflowReceiptId
    );
  }

  private rejected(): StartOperationResult {
    return { kind: "rejected", failure: { code: "maintenance-required" } };
  }
}
