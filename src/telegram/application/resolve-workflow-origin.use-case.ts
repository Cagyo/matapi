import { Injectable } from '@nestjs/common';
import { AdminHomeViewForbiddenError } from '../domain/errors/admin-home-view-forbidden.error';
import { NotificationTargetUnavailableError } from '../domain/errors/notification-target-unavailable.error';
import { encodeHomeView, parseHomeView, type HomeView } from '../domain/home-session';
import type { Role } from '../domain/role';
import type { ExternalWorkflow } from '../domain/workflow-return';
import { GetHomeScreenUseCase } from './get-home-screen.use-case';
import { homeViewForScreen } from './home-screen';

export interface ResolveWorkflowOriginInput {
  userId: number;
  chatId: number;
  role: Role;
  workflow: ExternalWorkflow;
  requested: HomeView;
  originSource: 'captured' | 'natural-parent';
}

export function naturalWorkflowOrigin(workflow: ExternalWorkflow): HomeView {
  switch (workflow) {
    case 'logs': case 'csv': return { kind: 'history' };
    case 'language': case 'help': return { kind: 'more' };
    case 'sensor-add': case 'sensor-modify': case 'sensor-remove':
    case 'sensor-import': case 'sensor-export':
      return { kind: 'admin-sensor-setup' };
    case 'drive-status': case 'drive-setup': case 'storage-cleanup':
      return { kind: 'admin-storage' };
    case 'health': case 'system-update': case 'system-restart':
    case 'ota-update': case 'ota-rollback':
      return { kind: 'admin-system' };
    case 'invite': return { kind: 'admin-tools' };
    case 'camera': return { kind: 'home', checking: false };
  }
}

@Injectable()
export class ResolveWorkflowOriginUseCase {
  constructor(private readonly screens: GetHomeScreenUseCase) {}

  async execute(input: ResolveWorkflowOriginInput): Promise<HomeView> {
    const natural = naturalWorkflowOrigin(input.workflow);
    const captured = input.originSource === 'captured' ? canonicalHomeView(input.requested) : null;
    let candidate = captured ?? natural;

    for (;;) {
      try {
        const screen = await this.screens.execute({
          userId: input.userId,
          chatId: input.chatId,
          role: input.role,
          view: candidate,
        });
        const resolved = homeViewForScreen(screen);
        if (resolved.kind !== 'notification-target') return resolved;
        const containingList = await this.screens.execute({
          userId: input.userId,
          chatId: input.chatId,
          role: input.role,
          view: { kind: 'notification-targets', page: resolved.page, targets: [] },
        });
        if (containingList.kind !== 'notification-targets') {
          throw new Error('Notification target list resolution returned an unexpected screen');
        }
        return { ...resolved, page: containingList.page.page };
      } catch (error) {
        if (!(error instanceof AdminHomeViewForbiddenError)
          && !(error instanceof NotificationTargetUnavailableError)) throw error;
        candidate = parentHomeView(candidate) ?? { kind: 'home', checking: false };
      }
    }
  }
}

function canonicalHomeView(value: unknown): HomeView | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null;
  try {
    const encoded = encodeHomeView(value as HomeView);
    const parsed = parseHomeView(value.kind, encoded.sensorPage, encoded.payload, encoded.checking);
    return parsed !== null && JSON.stringify(parsed) === JSON.stringify(value) ? parsed : null;
  } catch {
    return null;
  }
}

function parentHomeView(view: HomeView): HomeView | null {
  switch (view.kind) {
    case 'home': return null;
    case 'sensors': case 'notifications': case 'more': return { kind: 'home', checking: false };
    case 'notification-targets': case 'pause-duration': return { kind: 'notifications' };
    case 'notification-target': return { kind: 'notification-targets', page: view.page, targets: [] };
    case 'pause-confirmation': return { kind: 'pause-duration' };
    case 'history': case 'admin-tools': return { kind: 'more' };
    case 'admin-sensor-setup': case 'admin-storage': case 'admin-system': return { kind: 'admin-tools' };
    case 'admin-cleanup-threshold': return { kind: 'admin-system' };
    case 'confirmation': return view.action === 'cleanup' ? { kind: 'admin-storage' } : { kind: 'admin-system' };
    case 'cleanup-result': return { kind: 'admin-storage' };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
