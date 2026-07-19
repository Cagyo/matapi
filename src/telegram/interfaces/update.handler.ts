import { Injectable, Logger } from "@nestjs/common";
import { Composer, InlineKeyboard } from "grammy";
import { en } from "../../locales/en";
import type { LocaleCatalog } from "../../locales";
import {
  isOtaFailureCode,
  type OtaFailureCode,
} from "../../system/domain/ota-failure";
import { UpdateSystemUseCase } from "../application/update-system.use-case";
import { workflowReturnCallback } from "../domain/workflow-return";
import { RoleMiddleware } from "./role.middleware";
import { TelegramContext } from "./telegram-context";
import { TelegramHandler } from "./telegram-handler";
import { WorkflowEntryCoordinator } from "./workflow-entry.coordinator";

@Injectable()
export class UpdateHandler implements TelegramHandler {
  private readonly logger = new Logger(UpdateHandler.name);

  constructor(
    private readonly update: UpdateSystemUseCase,
    private readonly guard: RoleMiddleware,
    private readonly workflows: WorkflowEntryCoordinator,
  ) {}

  register(composer: Composer<TelegramContext>): void {
    composer.command("update", this.guard.adminOnly, (ctx) => this.handle(ctx));
  }

  private async handle(ctx: TelegramContext): Promise<void> {
    const catalog = ctx.localeState?.catalog ?? en;
    try {
      await ctx.reply(catalog.ota.checking);
      const check = await this.update.check();
      if (check.kind === "failure") {
        await ctx.reply(catalog.ota.operationFailure(check.failure.code));
        return;
      }
      if (check.kind === "current") {
        await ctx.reply(catalog.ota.upToDate);
        return;
      }
      const receipt = await this.workflows.begin(ctx, "ota-update", {
        source: "natural-parent",
      });
      if (!receipt || !(await this.workflows.markRunning(ctx, receipt))) {
        await ctx.reply(catalog.ota.operationFailure("maintenance-required"));
        return;
      }
      const outcome = await this.update.launch({
        checked: check.available,
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
      await ctx.reply(catalog.ota.updating(outcome.commit.slice(0, 7)), {
        reply_markup: this.runningKeyboard(catalog, receipt.id),
      });
    } catch (error) {
      this.logger.error("/update failed", (error as Error).stack);
      await ctx.reply(
        catalog.ota.operationFailure(
          this.failureCode(error) ?? "maintenance-required",
        ),
      );
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

  private failureCode(error: unknown): OtaFailureCode | null {
    const code = (error as { failure?: { code?: unknown } }).failure?.code;
    return isOtaFailureCode(code) ? code : null;
  }
}
