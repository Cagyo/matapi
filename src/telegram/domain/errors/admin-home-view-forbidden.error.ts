import type { HomeView } from '../home-session';

export class AdminHomeViewForbiddenError extends Error {
  readonly code = 'ADMIN_HOME_VIEW_FORBIDDEN' as const;

  constructor(readonly view: HomeView) {
    super(`Admin Home view '${view.kind}' is forbidden for the current role`);
    this.name = 'AdminHomeViewForbiddenError';
  }
}
