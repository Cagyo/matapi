import { Injectable, Logger } from '@nestjs/common';
import { Composer } from 'grammy';
import { DisableFeatureUseCase } from '../../features/application/disable-feature.use-case';
import { EnableFeatureUseCase } from '../../features/application/enable-feature.use-case';
import { ListFeaturesUseCase } from '../../features/application/list-features.use-case';
import { FeatureAlreadyDisabledError } from '../../features/domain/errors/feature-already-disabled.error';
import { FeatureAlreadyEnabledError } from '../../features/domain/errors/feature-already-enabled.error';
import { FeatureNotInstalledError } from '../../features/domain/errors/feature-not-installed.error';
import { UnknownFeatureError } from '../../features/domain/errors/unknown-feature.error';
import { catalogFor } from '../../locales';
import { en } from '../../locales/en';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';
import { TelegramContext } from './telegram-context';

/** Spec 17 — `/feature enable|disable|list` (admin only). */
@Injectable()
export class FeatureHandler implements TelegramHandler {
  private readonly logger = new Logger(FeatureHandler.name);

  constructor(
    private readonly enable: EnableFeatureUseCase,
    private readonly disable: DisableFeatureUseCase,
    private readonly list: ListFeaturesUseCase,
    private readonly guard: RoleMiddleware,
  ) {}

  register(composer: Composer<TelegramContext>): void {
    composer.command('feature', this.guard.adminOnly, async (ctx: TelegramContext) => {
      const args = (ctx.match ?? '')
        .toString()
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const [sub, name] = args;

      switch (sub) {
        case 'list':
          return this.handleList(ctx);
        case 'enable':
          return this.handleToggle(ctx, name, true);
        case 'disable':
          return this.handleToggle(ctx, name, false);
        default:
          await ctx.reply(en.feature.usage);
          return;
      }
    });
  }

  private async handleList(ctx: TelegramContext): Promise<void> {
    try {
      const descriptions = (ctx.localeState?.catalog ?? catalogFor('en'))
        .setupWizard.featureDescriptions as Record<string, string>;
      const features = await this.list.execute((key) => descriptions[key]);
      const body = features.map((f) => en.feature.listLine(f)).join('\n');
      await ctx.reply(`${en.feature.listHeader}\n\n${body}`);
    } catch (err) {
      this.logger.error(
        `/feature list failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
      await ctx.reply(en.feature.listFailed);
    }
  }

  private async handleToggle(
    ctx: TelegramContext,
    name: string | undefined,
    enabled: boolean,
  ): Promise<void> {
    if (!name) {
      await ctx.reply(en.feature.usage);
      return;
    }
    try {
      if (enabled) {
        await this.enable.execute(name);
        await ctx.reply(en.feature.enabled(name));
      } else {
        await this.disable.execute(name);
        await ctx.reply(en.feature.disabled(name));
      }
    } catch (err) {
      if (err instanceof UnknownFeatureError) {
        await ctx.reply(en.feature.unknown(err.featureName));
        return;
      }
      if (err instanceof FeatureNotInstalledError) {
        await ctx.reply(en.feature.notInstalled(err.featureName));
        return;
      }
      if (err instanceof FeatureAlreadyEnabledError) {
        await ctx.reply(en.feature.alreadyEnabled(err.featureName));
        return;
      }
      if (err instanceof FeatureAlreadyDisabledError) {
        await ctx.reply(en.feature.alreadyDisabled(err.featureName));
        return;
      }
      this.logger.error(
        `/feature ${enabled ? 'enable' : 'disable'} failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
      await ctx.reply(
        enabled ? en.feature.enableFailed : en.feature.disableFailed,
      );
    }
  }
}
