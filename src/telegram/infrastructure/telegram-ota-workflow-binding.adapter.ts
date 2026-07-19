import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { OtaWorkflowBindingRegistry } from "../../system/application/ota-workflow-binding.registry";
import type {
  OtaWorkflowBindingPort,
  OtaWorkflowBindingRequest,
} from "../../system/application/ports/ota-workflow-binding.port";
import {
  OTA_OPERATION_WORKFLOW_REPOSITORY,
  type OtaOperationWorkflowRepositoryPort,
} from "../application/ports/ota-operation-workflow-repository.port";

/** Binds a reserved operation to the exact durable Telegram workflow route. */
@Injectable()
export class TelegramOtaWorkflowBindingAdapter
  implements OtaWorkflowBindingPort, OnModuleInit, OnModuleDestroy
{
  constructor(
    private readonly registry: OtaWorkflowBindingRegistry,
    @Inject(OTA_OPERATION_WORKFLOW_REPOSITORY)
    private readonly routes: OtaOperationWorkflowRepositoryPort,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  onModuleDestroy(): void {
    this.registry.clear(this);
  }

  async bind(request: OtaWorkflowBindingRequest): Promise<boolean> {
    const result = await this.routes.authorize({
      operationId: request.receipt.operationId,
      operationKind: request.receipt.kind,
      userId: request.workflow.userId,
      chatId: request.workflow.chatId,
      workflowReceiptId: request.workflow.workflowReceiptId,
      authorizedAt: new Date(request.receipt.acceptedAt),
    });
    return result === "authorized";
  }
}
