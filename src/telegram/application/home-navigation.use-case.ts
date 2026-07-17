import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type ClockPort } from '../../events/domain/ports/clock.port';
import type { HomeAction } from '../domain/home-callback';
import type { HomeIdentity, HomeView } from '../domain/home-session';
import { HOME_TOKEN_GENERATOR, type HomeTokenGeneratorPort } from '../domain/ports/home-token-generator.port';
import type { Role } from '../domain/role';
import { HOME_ACTION_REPOSITORY, type HomeActionRepositoryPort } from './ports/home-action-repository.port';

export type HomeNavigationResult =
  | { kind: 'render'; view: HomeView }
  | { kind: 'external'; destination: 'camera' | 'history-logs' | 'history-csv' | 'settings' | 'help' | 'config-add' | 'config-modify' | 'config-remove' | 'config-import' | 'config-export' | 'drive-status' | 'drive-connect' | 'system-health' | 'system-packages' | 'invite' }
  | { kind: 'restart' }
  | { kind: 'recovery'; reason: 'expired' | 'superseded' | 'executing' | 'terminal' | 'target-unavailable' | 'admin-required' };

export interface HomeNavigationInput {
  active: HomeIdentity;
  role: Role;
  view: HomeView;
  action: HomeAction;
}

const CONFIRMATION_TTL_MS = 120_000;

function parentView(view: HomeView): HomeView | null {
  switch (view.kind) {
    case 'home': return null;
    case 'sensors':
    case 'notifications':
    case 'more': return { kind: 'home', checking: false };
    case 'notification-targets':
    case 'pause-duration': return { kind: 'notifications' };
    case 'notification-target': return { kind: 'notification-targets', page: view.page, targets: [] };
    case 'pause-confirmation': return { kind: 'pause-duration' };
    case 'history':
    case 'admin-tools': return { kind: 'more' };
    case 'admin-sensor-setup':
    case 'admin-storage':
    case 'admin-system': return { kind: 'admin-tools' };
    case 'admin-cleanup-threshold': return { kind: 'admin-system' };
    case 'confirmation': return view.action === 'cleanup' ? { kind: 'admin-storage' } : { kind: 'admin-system' };
    case 'cleanup-result': return { kind: 'admin-storage' };
  }
}

@Injectable()
export class HomeNavigationUseCase {
  constructor(
    @Inject(HOME_ACTION_REPOSITORY) private readonly actions: HomeActionRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(HOME_TOKEN_GENERATOR) private readonly tokens: HomeTokenGeneratorPort,
  ) {}

  async execute(input: HomeNavigationInput): Promise<HomeNavigationResult> {
    const { action, view } = input;
    if (action.kind === 'refresh') return { kind: 'render', view };
    if (action.kind === 'back') {
      const parent = parentView(view);
      return parent ? { kind: 'render', view: parent } : { kind: 'recovery', reason: 'superseded' };
    }
    if (action.kind === 'confirm-pause') {
      if (view.kind !== 'pause-confirmation' || view.receiptId !== action.receiptId) return { kind: 'recovery', reason: 'superseded' };
      const result = await this.actions.confirmPause({
        userId: input.active.userId, chatId: input.active.chatId, token: input.active.token,
        id: action.receiptId, hours: view.hours, now: this.clock.now(),
      });
      return result.kind === 'applied' ? { kind: 'render', view: { kind: 'notifications' } } : { kind: 'recovery', reason: result.kind };
    }
    if (action.kind === 'undo-pause') {
      if (view.kind !== 'notifications') return { kind: 'recovery', reason: 'superseded' };
      const result = await this.actions.undoPause({ userId: input.active.userId, chatId: input.active.chatId, id: action.receiptId, now: this.clock.now() });
      return result.kind === 'applied' ? { kind: 'render', view: { kind: 'notifications' } } : { kind: 'recovery', reason: result.kind };
    }
    if (action.kind === 'quiet-hours') {
      if (view.kind !== 'notifications') return { kind: 'recovery', reason: 'superseded' };
      const ranges = { '22-07': ['22:00', '07:00'], '23-06': ['23:00', '06:00'], '00-08': ['00:00', '08:00'], off: [null, null] } as const;
      const [start, end] = ranges[action.preset];
      const now = this.clock.now();
      const result = await this.actions.setQuietHours({
        userId: input.active.userId, chatId: input.active.chatId, start, end, id: this.tokens.generate(),
        expiresAt: new Date(now.getTime() + 600_000), now,
      });
      return result.kind === 'applied' ? { kind: 'render', view: { kind: 'notifications' } } : { kind: 'recovery', reason: 'superseded' };
    }
    if (action.kind === 'undo-quiet-hours') {
      if (view.kind !== 'notifications') return { kind: 'recovery', reason: 'superseded' };
      const result = await this.actions.undoQuietHours({ userId: input.active.userId, chatId: input.active.chatId, id: action.receiptId, now: this.clock.now() });
      return result.kind === 'applied' ? { kind: 'render', view: { kind: 'notifications' } } : { kind: 'recovery', reason: result.kind };
    }
    if (action.kind === 'pause-hours') {
      if (view.kind !== 'pause-duration') return { kind: 'recovery', reason: 'superseded' };
      const now = this.clock.now();
      const id = this.tokens.generate();
      await this.actions.createPauseConfirmation({
        id, userId: input.active.userId, chatId: input.active.chatId,
        kind: 'pause-confirmation', sessionToken: input.active.token, status: 'pending',
        payload: { hours: action.hours }, expiresAt: new Date(now.getTime() + CONFIRMATION_TTL_MS),
      });
      return { kind: 'render', view: { kind: 'pause-confirmation', hours: action.hours, receiptId: id } };
    }
    if (action.kind === 'cleanup' || action.kind === 'restart') {
      if (input.role !== 'admin') return { kind: 'recovery', reason: 'admin-required' };
      const requiredView = action.kind === 'cleanup' ? 'admin-storage' : 'admin-system';
      if (view.kind !== requiredView) return { kind: 'recovery', reason: 'superseded' };
      const now = this.clock.now();
      const id = this.tokens.generate();
      const kind = action.kind === 'cleanup' ? 'cleanup-confirmation' as const : 'restart-confirmation' as const;
      await this.actions.createExternalConfirmation({
        id, userId: input.active.userId, chatId: input.active.chatId, kind,
        sessionToken: input.active.token, status: 'pending', payload: {},
        expiresAt: new Date(now.getTime() + CONFIRMATION_TTL_MS),
      });
      return { kind: 'render', view: { kind: 'confirmation', action: action.kind, receiptId: id } };
    }
    if (action.kind === 'confirm-cleanup' || action.kind === 'confirm-restart') {
      const expected = action.kind === 'confirm-cleanup' ? 'cleanup' : 'restart';
      const kind = action.kind === 'confirm-cleanup' ? 'cleanup-confirmation' as const : 'restart-confirmation' as const;
      if (view.kind !== 'confirmation' || view.action !== expected || view.receiptId !== action.receiptId) return { kind: 'recovery', reason: 'superseded' };
      const result = await this.actions.claimExternal({ userId: input.active.userId, chatId: input.active.chatId, token: input.active.token, kind, id: action.receiptId, now: this.clock.now() });
      if (result.kind !== 'claimed') return { kind: 'recovery', reason: result.kind };
      return expected === 'restart'
        ? { kind: 'restart' }
        : { kind: 'render', view: { kind: 'cleanup-result', outcome: 'in-progress', threshold: null } };
    }
    if (action.kind === 'notifications' && view.kind === 'home') return { kind: 'render', view: { kind: 'notifications' } };
    if (action.kind === 'more' && view.kind === 'home') return { kind: 'render', view: { kind: 'more' } };
    if (action.kind === 'history' && view.kind === 'more') return { kind: 'render', view: { kind: 'history' } };
    if (action.kind === 'admin-tools' && view.kind === 'more') return input.role === 'admin' ? { kind: 'render', view: { kind: 'admin-tools' } } : { kind: 'recovery', reason: 'admin-required' };
    if (action.kind === 'admin-sensor-setup' && view.kind === 'admin-tools' && input.role === 'admin') return { kind: 'render', view: { kind: 'admin-sensor-setup' } };
    if (action.kind === 'admin-storage' && view.kind === 'admin-tools' && input.role === 'admin') return { kind: 'render', view: { kind: 'admin-storage' } };
    if (action.kind === 'admin-system' && view.kind === 'admin-tools' && input.role === 'admin') return { kind: 'render', view: { kind: 'admin-system' } };
    if (action.kind === 'admin-cleanup-threshold' && view.kind === 'admin-system' && input.role === 'admin') return { kind: 'render', view: { kind: 'admin-cleanup-threshold' } };
    if (action.kind === 'pause-duration' && view.kind === 'notifications') return { kind: 'render', view: { kind: 'pause-duration' } };
    if (action.kind === 'notification-targets' && view.kind === 'notifications') return { kind: 'render', view: { kind: 'notification-targets', page: action.page, targets: [] } };
    if (action.kind === 'notification-target' && view.kind === 'notification-targets' && action.index < view.targets.length) return { kind: 'render', view: { kind: 'notification-target', page: view.page, target: view.targets[action.index] } };
    if ((action.kind === 'notification-target-mute' || action.kind === 'notification-target-unmute') && view.kind === 'notification-target') return { kind: 'render', view };
    if (action.kind === 'history-logs' && view.kind === 'history') return { kind: 'external', destination: 'history-logs' };
    if (action.kind === 'history-csv' && view.kind === 'history') return { kind: 'external', destination: 'history-csv' };
    if (action.kind === 'settings' && view.kind === 'more') return { kind: 'external', destination: 'settings' };
    if (action.kind === 'help' && view.kind === 'more') return { kind: 'external', destination: 'help' };
    if (action.kind === 'invite' && view.kind === 'admin-tools' && input.role === 'admin') return { kind: 'external', destination: 'invite' };
    const adminExternal: Record<string, 'config-add' | 'config-modify' | 'config-remove' | 'config-import' | 'config-export' | 'drive-status' | 'drive-connect' | 'system-health' | 'system-packages'> = {
      'config-add': 'config-add', 'config-modify': 'config-modify', 'config-remove': 'config-remove', 'config-import': 'config-import', 'config-export': 'config-export',
      'drive-status': 'drive-status', 'drive-connect': 'drive-connect', 'system-health': 'system-health', 'system-packages': 'system-packages',
    };
    if (action.kind in adminExternal && input.role === 'admin') {
      const expectedView = action.kind.startsWith('config-') ? 'admin-sensor-setup' : action.kind.startsWith('drive-') ? 'admin-storage' : 'admin-system';
      if (view.kind === expectedView) return { kind: 'external', destination: adminExternal[action.kind] };
    }
    if (action.kind === 'auto-clean-threshold' && view.kind === 'admin-cleanup-threshold' && input.role === 'admin') return { kind: 'render', view };
    if (action.kind === 'camera' && view.kind === 'home') return { kind: 'external', destination: 'camera' };
    if (action.kind === 'home') return { kind: 'render', view: { kind: 'home', checking: false } };
    if (action.kind === 'sensors' && (view.kind === 'home' || view.kind === 'sensors')) return { kind: 'render', view: { kind: 'sensors', page: action.page, checking: false } };
    if (action.kind === 'check' && (view.kind === 'home' || view.kind === 'sensors')) return { kind: 'render', view: { ...view, checking: true } };
    return { kind: 'recovery', reason: 'superseded' };
  }
}
