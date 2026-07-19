import { Inject, Injectable, Logger } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { catalogFor } from "../../locales";
import type { StartupReportDeliveryPort } from "../../system/application/consume-startup-report.use-case";
import type { StartupReport } from "../../system/domain/ota-contracts";
import {
  OTA_OPERATION_WORKFLOW_REPOSITORY,
  type OtaOperationWorkflowRepositoryPort,
} from "../application/ports/ota-operation-workflow-repository.port";
import {
  OTA_WORKFLOW_COMPLETION,
  type OtaWorkflowCompletionPort,
} from "../application/ports/startup-report-delivery-adapter.port";
import { RestoreWorkflowOriginUseCase } from "../application/restore-workflow-origin.use-case";
import {
  DIRECT_MESSENGER,
  type DirectMessengerPort,
} from "../domain/ports/direct-messenger.port";
import {
  USER_REPOSITORY,
  type UserRepositoryPort,
} from "../domain/ports/user-repository.port";

const DELIVERY_LEASE_MS = 60_000;

@Injectable()
export class TelegramStartupReportDeliveryAdapter implements StartupReportDeliveryPort {
  private readonly logger = new Logger(
    TelegramStartupReportDeliveryAdapter.name,
  );

  constructor(
    @Inject(OTA_OPERATION_WORKFLOW_REPOSITORY)
    private readonly routes: OtaOperationWorkflowRepositoryPort,
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(DIRECT_MESSENGER) private readonly messenger: DirectMessengerPort,
    @Inject(OTA_WORKFLOW_COMPLETION)
    private readonly workflows: OtaWorkflowCompletionPort,
    private readonly restoreWorkflow: RestoreWorkflowOriginUseCase,
  ) {}

  async deliver(report: StartupReport): Promise<{ delivered: number }> {
    if (report.operationId === null || report.kind === null) {
      return this.deliverMaintenance(report);
    }
    const now = new Date();
    const leaseId = randomBytes(16).toString("base64url");
    const claim = await this.routes.claimDelivery({
      operationId: report.operationId,
      operationKind: report.kind,
      leaseId,
      now,
      leaseUntil: new Date(now.getTime() + DELIVERY_LEASE_MS),
    });
    if (claim.kind === "acknowledged") return { delivered: 1 };
    if (claim.kind === "delivered") {
      const acknowledged = await this.routes.acknowledge({
        operationId: report.operationId,
        leaseId,
        acknowledgedAt: new Date(),
      });
      return { delivered: acknowledged ? 1 : 0 };
    }
    if (claim.kind !== "claimed") return { delivered: 0 };

    const user = await this.users.findByTelegramId(claim.route.userId);
    if (!user) return { delivered: 0 };
    const catalog = catalogFor(user.locale);
    const text = report.failure
      ? catalog.ota.operationFailure(report.failure.code)
      : catalog.ota.operationOutcome(report.kind, report.outcome);
    const result = await this.workflows.completeHeadless({
      identity: {
        userId: claim.route.userId,
        chatId: claim.route.chatId,
        locale: user.locale,
        role: user.role,
        catalog,
      },
      workflow: claim.route.workflow,
      deliver: () => this.messenger.send(claim.route.chatId, text),
      recoveryNotice: text,
      restore: async (receipt, notice) => {
        if (receipt.id !== claim.route.workflowReceiptId) return false;
        const restored = await this.restoreWorkflow.execute({
          userId: claim.route.userId,
          chatId: claim.route.chatId,
          locale: user.locale,
          role: user.role,
          workflow: claim.route.workflow,
          requested: { kind: "admin-system" },
          originSource: "natural-parent",
          notice,
        });
        return restored.kind === "opened";
      },
    });
    if (result !== "completed") return { delivered: 0 };
    const delivered = await this.routes.markDelivered({
      operationId: report.operationId,
      leaseId,
      deliveredAt: new Date(),
    });
    if (!delivered) return { delivered: 0 };
    const acknowledged = await this.routes.acknowledge({
      operationId: report.operationId,
      leaseId,
      acknowledgedAt: new Date(),
    });
    return { delivered: acknowledged ? 1 : 0 };
  }

  private async deliverMaintenance(
    report: StartupReport,
  ): Promise<{ delivered: number }> {
    const failure = report.failure?.code ?? "maintenance-required";
    const recipients = (await this.users.listRecipients()).filter(
      (user) => user.role === "admin",
    );
    const results = await Promise.all(
      recipients.map(async (admin) => {
        try {
          await this.messenger.send(
            admin.telegramId,
            catalogFor(admin.locale).ota.maintenanceOutcome(failure),
          );
          return true;
        } catch {
          this.logger.warn("OTA maintenance report delivery failed");
          return false;
        }
      }),
    );
    return { delivered: results.filter(Boolean).length };
  }
}
