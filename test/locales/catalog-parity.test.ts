import { describe, expect, it } from 'vitest';
import type { DriveStatusReport } from '../../src/archive/application/use-cases/report-drive-status.use-case';
import { catalogFor, catalogs } from '../../src/locales';

const report: DriveStatusReport = {
  connection: null,
  account: null,
  folders: null,
  last: {
    refreshAtMs: null,
    uploadAtMs: null,
    backupAtMs: null,
    reconcileAtMs: null,
    cleanupAtMs: null,
    motionTraversalAtMs: 1_000,
    artifactRegistrationAtMs: 2_000,
  },
  artifacts: { stabilizing: 0, pending: 12, verified: 0, local_missing: 0, superseded: 0 },
  attempts: { pending: 0, uploading: 0, retryable: 0, verified: 0, missing: 0, detached: 0, conflict: 0, abandoned: 0, deleted: 0 },
  generations: [],
  quota: null,
  reclamation: null,
  requiredAction: 'restore-date-folder',
  recovery: { generationId: 'generation-sensitive', providerRevision: 7, retryable: true },
  queue: {
    queuedVideos: 12,
    retryableVideos: 3,
    oldestQueuedVideoAgeMs: 60_000,
    unhealthyDateFolders: 2,
  },
  drainState: 'branch-blocked',
};

describe('Drive status and alert catalog parity', () => {
  it('renders aggregate backlog data without IDs or local paths', () => {
    const rendered = catalogFor('en').gdrive.body(report);

    expect(rendered).toContain('Queued videos: 12');
    expect(rendered).toContain('Unhealthy date folders: 2');
    expect(rendered).toContain(catalogFor('en').gdrive.actions['restore-date-folder']);
    expect(rendered).not.toContain('generation-sensitive');
    expect(rendered).not.toContain('folder-id');
    expect(rendered).not.toContain('/home/pi/motion');
  });

  it('keeps every continuous-drain alert generic and present in every locale', () => {
    const kinds = [
      'folder-branch-unhealthy',
      'provider-cooldown-prolonged',
      'provider-capacity-blocked',
      'backlog-age-prolonged',
    ] as const;

    for (const catalog of [catalogs.en, catalogs.ru, catalogs.uk]) {
      expect(Object.keys(catalog.gdrive.alerts).sort())
        .toEqual(Object.keys(catalogs.en.gdrive.alerts).sort());
      for (const kind of kinds) {
        expect(catalog.gdrive.alerts[kind]).toEqual(expect.any(String));
        expect(catalog.gdrive.alerts[kind]).not.toContain('/');
        expect(catalog.gdrive.alerts[kind]).not.toContain('folder-id');
      }
    }
  });

  it('advertises the retry action in every localized admin help descriptor', () => {
    for (const catalog of [catalogs.en, catalogs.ru, catalogs.uk]) {
      expect(catalog.help.admin).toContain('/gdrive connect|status|retry|disconnect');
    }
  });
});
