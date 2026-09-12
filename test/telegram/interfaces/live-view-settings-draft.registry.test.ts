import { describe, expect, it } from 'vitest';
import { LiveViewSettingsDraftRegistry } from '../../../src/telegram/interfaces/live-view-settings-draft.registry';
import { WorkflowDraftRegistry } from '../../../src/telegram/interfaces/workflow-draft.registry';

const identity = { receiptId: 'abcdefghijklmnop', userId: 1, chatId: 1 };
function setup() {
  let now = 0;
  const workflows = new WorkflowDraftRegistry();
  const registry = new LiveViewSettingsDraftRegistry({ now: () => new Date(now) }, workflows);
  registry.onModuleInit();
  const draft = registry.create({ ...identity, expectedGeneration: 4, candidate: { enabled: false, allowedCameraCidrs: [] } });
  return { registry, workflows, draft, advance: (ms: number) => { now += ms; } };
}

describe('LiveViewSettingsDraftRegistry', () => {
  it('fences identities before resolving or deleting a draft', async () => {
    const { registry, draft } = setup();
    expect(registry.resolve({ ...identity, userId: 2 })).toEqual({ kind: 'mismatched' });
    expect(await registry.cancelExact({ ...identity, chatId: 2 })).toBe('superseded');
    expect(registry.resolve(identity)).toEqual({ kind: 'found', draft });
  });

  it('expires the entire draft at ten minutes and recovers a lost draft', () => {
    const { registry, advance } = setup();
    advance(600_000);
    expect(registry.resolve(identity)).toEqual({ kind: 'expired' });
    expect(registry.resolve(identity)).toEqual({ kind: 'missing' });
  });

  it('delegates Cancel, Back and Home cleanup through the existing registry', async () => {
    const { registry, workflows } = setup();
    await workflows.cancelExact({ id: identity.receiptId, userId: 1, chatId: 1, payload: { workflow: 'live-view-settings' } } as never);
    expect(registry.resolve(identity)).toEqual({ kind: 'missing' });
  });

  it('drops all owned drafts on role loss', () => {
    const { registry } = setup();
    registry.cancelUser(1);
    expect(registry.resolve(identity)).toEqual({ kind: 'missing' });
  });

  it('resolves only selectors on the currently displayed suggestion page', () => {
    const { registry, draft } = setup();
    draft.suggestionPage = 1;
    draft.suggestions = [{ selector: '0', cidr: '192.168.1.0/24', interfaceLabels: ['eth0'], interfaceLabelCount: 1 }];
    expect(registry.addSuggestion(draft, 0, 0)).toBe('stale');
    expect(registry.addSuggestion(draft, 1, 0)).toBe('added');
    expect(draft.candidate.allowedCameraCidrs).toEqual(['192.168.1.0/24']);
  });

  it('requires explicit host-bit confirmation and replaces a pending normalization', () => {
    const { registry, draft } = setup();
    expect(registry.addManual(draft, '192.168.1.42/24')).toBe('normalization');
    expect(draft.candidate.allowedCameraCidrs).toEqual([]);
    registry.addManual(draft, '10.1.2.3/16');
    expect(draft.pendingNormalization).toEqual({ entered: '10.1.2.3/16', canonical: '10.1.0.0/16' });
    expect(registry.confirmNormalization(draft)).toBe('added');
    expect(draft.candidate.allowedCameraCidrs).toEqual(['10.1.0.0/16']);
    expect(draft.pendingNormalization).toBeNull();
  });

  it('preserves valid entries on invalid input, deduplicates, bounds at sixteen and removes', () => {
    const { registry, draft } = setup();
    for (let n = 0; n < 16; n++) registry.addManual(draft, `10.${n}.0.0/16`);
    expect(registry.addManual(draft, '10.0.0.0/16')).toBe('duplicate');
    expect(registry.addManual(draft, '10.16.0.0/16')).toBe('limit');
    expect(registry.addManual(draft, '8.8.8.8/32')).toBe('invalid');
    expect(draft.candidate.allowedCameraCidrs).toHaveLength(16);
    registry.remove(draft, 0);
    expect(draft.candidate.allowedCameraCidrs).toHaveLength(15);
    expect(registry.addManual(draft, '10.16.0.0/16')).toBe('added');
  });
});
