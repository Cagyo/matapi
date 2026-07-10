import { Injectable, Logger } from '@nestjs/common';
import { Composer, Context } from 'grammy';
import { networkInterfaces, NetworkInterfaceInfo } from 'node:os';
import { UpdateGdriveAuthUseCase } from '../../camera/application/update-gdrive-auth.use-case';
import { GdriveAuthFailedError } from '../../camera/domain/errors/gdrive-auth-failed.error';
import { GdriveNotInstalledError } from '../../camera/domain/errors/gdrive-not-installed.error';
import { en, gb } from '../../locales/en';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';

const FALLBACK_SSH_HOST = '<pi-host>';
const SSH_HOST_ENV = 'HOME_WORKER_SSH_HOST';

function interfacePriority(name: string): number {
  const lower = name.toLowerCase();
  if (/^(wlan|wl)/.test(lower)) return 0;
  if (/^(eth|en)/.test(lower)) return 1;
  if (/^(usb|wwan)/.test(lower)) return 2;
  if (/^(docker|br-|veth|lo|tun|tap|tailscale|zt)/.test(lower)) return 9;
  return 5;
}

function isUsableIpv4(address: NetworkInterfaceInfo): boolean {
  return (
    address.family === 'IPv4' &&
    !address.internal &&
    !address.address.startsWith('169.254.')
  );
}

export function resolveLocalSshHost(): string {
  const configured = process.env[SSH_HOST_ENV]?.trim();
  if (configured) return configured;

  const interfaces = networkInterfaces();
  const names = Object.keys(interfaces).sort(
    (a, b) => interfacePriority(a) - interfacePriority(b),
  );

  for (const name of names) {
    const address = interfaces[name]?.find(isUsableIpv4);
    if (address) return address.address;
  }

  return FALLBACK_SSH_HOST;
}

@Injectable()
export class GdriveAuthHandler implements TelegramHandler {
  private readonly logger = new Logger(GdriveAuthHandler.name);
  private readonly states = new Map<number, 'awaitingConfig'>();
  private readonly botToken = process.env.TELEGRAM_BOT_TOKEN ?? '';

  constructor(
    private readonly updateGdriveAuth: UpdateGdriveAuthUseCase,
    private readonly guard: RoleMiddleware,
  ) {}

  register(composer: Composer<Context>): void {
    composer.command('gdrive_auth', this.guard.adminOnly, (ctx) =>
      this.startWizard(ctx),
    );

    composer.command('cancel', this.guard.adminOnly, async (ctx, next) => {
      const userId = ctx.from?.id;
      if (userId && this.states.has(userId)) {
        this.states.delete(userId);
        await ctx.reply(en.gdriveAuth.cancelled);
        return;
      }
      return next();
    });

    composer.callbackQuery('gdauth:start', this.guard.adminOnly, async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      await this.startWizard(ctx);
    });

    composer.on('message:text', async (ctx, next) => {
      const userId = ctx.from?.id;
      if (!userId || !this.states.has(userId)) return next();
      const text = ctx.message?.text?.trim() ?? '';
      if (text.startsWith('/')) return next();

      if (!/\[gdrive\]/i.test(text)) {
        await ctx.reply(en.gdriveAuth.invalidSnippet, { parse_mode: 'Markdown' });
        return;
      }

      await this.processSnippet(ctx, userId, text);
    });

    composer.on('message:document', async (ctx, next) => {
      const userId = ctx.from?.id;
      if (!userId || !this.states.has(userId)) return next();

      const doc = ctx.message?.document;
      if (!doc) return;

      const name = doc.file_name ?? '';
      if (!/\.(conf|txt)$/i.test(name)) {
        await ctx.reply(en.gdriveAuth.invalidSnippet, { parse_mode: 'Markdown' });
        return;
      }

      let text: string;
      try {
        const file = await ctx.getFile();
        const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`download failed: ${response.status}`);
        }
        text = await response.text();
      } catch (error) {
        const token = this.botToken;
        const redactor = (str: string) =>
          token ? str.replace(new RegExp(token, 'g'), '[REDACTED_TOKEN]') : str;
        const msg = redactor((error as Error).message);
        const stack = redactor((error as Error).stack ?? '');
        this.logger.error(`gdrive_auth download failed: ${msg}`, stack);
        await ctx.reply(en.common.error('/gdrive_auth', 'could not download file'));
        return;
      }

      if (!/\[gdrive\]/i.test(text)) {
        await ctx.reply(en.gdriveAuth.invalidSnippet, { parse_mode: 'Markdown' });
        return;
      }

      await this.processSnippet(ctx, userId, text);
    });
  }

  async handleCommand(ctx: Context): Promise<void> {
    await this.startWizard(ctx);
  }

  private async startWizard(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;
    if (this.states.has(userId)) {
      await ctx.reply(en.gdriveAuth.alreadyInProgress);
      return;
    }
    this.states.set(userId, 'awaitingConfig');
    await ctx.reply(en.gdriveAuth.prompt(resolveLocalSshHost()), {
      parse_mode: 'Markdown',
    });
  }

  private async processSnippet(ctx: Context, userId: number, snippet: string): Promise<void> {
    try {
      const quota = await this.updateGdriveAuth.execute(snippet);
      this.states.delete(userId);
      await ctx.reply(en.gdriveAuth.success(gb(quota.usedBytes), gb(quota.totalBytes)));
    } catch (err) {
      if (err instanceof GdriveNotInstalledError) {
        this.states.delete(userId);
        await ctx.reply(en.gdriveAuth.notInstalled);
        return;
      }
      if (err instanceof GdriveAuthFailedError) {
        this.states.delete(userId);
        await ctx.reply(en.gdriveAuth.failed(err.reason));
        return;
      }
      this.logger.error(
        `/gdrive_auth failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
      await ctx.reply(en.common.error('/gdrive_auth', (err as Error).message));
    }
  }
}
