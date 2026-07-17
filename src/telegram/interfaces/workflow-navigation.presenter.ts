import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import type { WorkflowReturnDestination, WorkflowReturnReceipt } from '../domain/workflow-return';
import { workflowReturnCallback } from '../domain/workflow-return';

export interface WorkflowExitLabels {
  origin: string;
  home: string;
}

@Injectable()
export class WorkflowNavigationPresenter {
  appendExitRow(
    keyboard: InlineKeyboard,
    receipt: WorkflowReturnReceipt,
    labels: WorkflowExitLabels,
  ): InlineKeyboard {
    return keyboard.row()
      .text(labels.origin, workflowReturnCallback(receipt.id, 'origin'))
      .text(labels.home, workflowReturnCallback(receipt.id, 'home'));
  }

  cancelKeyboard(
    receipt: WorkflowReturnReceipt,
    labels: { cancel: string; home: string },
  ): InlineKeyboard {
    return new InlineKeyboard()
      .text(labels.cancel, workflowReturnCallback(receipt.id, 'origin'))
      .text(labels.home, workflowReturnCallback(receipt.id, 'home'));
  }

  runningKeyboard(
    receipt: WorkflowReturnReceipt,
    labels: WorkflowExitLabels,
  ): InlineKeyboard {
    return new InlineKeyboard()
      .text(labels.origin, workflowReturnCallback(receipt.id, 'origin'))
      .text(labels.home, workflowReturnCallback(receipt.id, 'home'));
  }

  retryReturnKeyboard(
    receipt: WorkflowReturnReceipt,
    input: { label: string; destination: WorkflowReturnDestination },
  ): InlineKeyboard {
    return new InlineKeyboard().text(
      input.label,
      workflowReturnCallback(receipt.id, input.destination),
    );
  }
}
