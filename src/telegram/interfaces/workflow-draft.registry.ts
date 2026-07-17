import { Injectable } from '@nestjs/common';
import type { ExternalWorkflow, WorkflowReturnReceipt } from '../domain/workflow-return';

export interface WorkflowDraftCanceller {
  cancelExact(input: {
    userId: number;
    chatId: number;
    receiptId: string;
  }): Promise<'cancelled' | 'missing' | 'superseded'>;
}

@Injectable()
export class WorkflowDraftRegistry {
  private readonly cancellers = new Map<ExternalWorkflow, WorkflowDraftCanceller>();

  register(workflow: ExternalWorkflow, canceller: WorkflowDraftCanceller): void {
    this.cancellers.set(workflow, canceller);
  }

  async cancelExact(
    receipt: WorkflowReturnReceipt,
  ): Promise<'cancelled' | 'missing' | 'superseded'> {
    const canceller = this.cancellers.get(receipt.payload.workflow);
    if (!canceller) return 'missing';
    return canceller.cancelExact({
      userId: receipt.userId,
      chatId: receipt.chatId,
      receiptId: receipt.id,
    });
  }
}
