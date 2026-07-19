import { Injectable, Logger } from "@nestjs/common";
import { Composer, InlineKeyboard } from "grammy";
import { en } from "../../locales/en";
import type { LocaleCatalog } from "../../locales";
import { RollbackSystemUseCase } from "../application/rollback-system.use-case";
import { workflowReturnCallback } from "../domain/workflow-return";
import { RoleMiddleware } from "./role.middleware";
import { TelegramContext } from "./telegram-context";
import { TelegramHandler } from "./telegram-handler";
import { WorkflowEntryCoordinator } from "./workflow-entry.coordinator";

@Injectable()
export class RollbackHandler implements TelegramHandler {
  private readonly logger = new Logger(RollbackHandler.name);

  constructor(
    private readonly rollback: RollbackSystemUseCase,
    private readonly guard: RoleMiddleware,
    private readonly workflows: WorkflowEntryCoordinator,
  ) {}

  register(composer: Composer<TelegramContext>): void {
    composer.command("rollback", this.guard.adminOnly, (ctx) =>
      this.handle(ctx),
    );
  }

  private async handle(ctx: TelegramContext): Promise<void> {
    const catalog = ctx.localeState?.catalog ?? en;
    try {
      const receipt = await this.workflows.begin(ctx, "ota-rollback", {
        source: "natural-parent",
      });
      if (!receipt || !(await this.workflows.markRunning(ctx, receipt))) {
        await ctx.reply(catalog.ota.operationFailure("maintenance-required"));
        return;
      }
      const outcome = await this.rollback.launch({
        userId: receipt.userId,
        chatId: receipt.chatId,
        workflowReceiptId: receipt.id,
      });
      if (outcome.kind === "failure") {
        await ctx.reply(catalog.ota.operationFailure(outcome.failure.code), {
          reply_markup: this.runningKeyboard(catalog, receipt.id),
        });
        return;
      }
      await ctx.reply(catalog.ota.rollbackStarting, {
        reply_markup: this.runningKeyboard(catalog, receipt.id),
      });
    } catch (error) {
      this.logger.error("/rollback failed", (error as Error).stack);
      await ctx.reply(catalog.ota.operationFailure("maintenance-required"));
    }
  }

  private runningKeyboard(
    catalog: LocaleCatalog,
    receiptId: string,
  ): InlineKeyboard {
    return new InlineKeyboard()
      .text(
        catalog.home.common.back,
        workflowReturnCallback(receiptId, "origin"),
      )
      .text(
        catalog.home.common.home,
        workflowReturnCallback(receiptId, "home"),
      );
  }
}
