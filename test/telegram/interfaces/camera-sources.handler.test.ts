import { describe, expect, it, vi } from 'vitest';
import type {
  RtspSourceOverview,
  RtspSourcesOverviewPage,
} from '../../../src/camera/application/get-rtsp-source-overview.use-case';
import { RTSP_SOURCE_CAMERA_TYPE } from '../../../src/camera/domain/ports/rtsp-source-configuration.port';
import { CameraSourceUnavailableError } from '../../../src/camera/domain/errors/camera-source-unavailable.error';
import { FeatureUnavailableError } from '../../../src/features/domain/errors/feature-unavailable.error';
import type { FeatureAvailabilityPort } from '../../../src/features/domain/ports/feature-availability.port';
import { catalogFor } from '../../../src/locales';
import type { WorkflowReturnReceipt } from '../../../src/telegram/domain/workflow-return';
import { CameraSourcesHandler } from '../../../src/telegram/interfaces/camera-sources.handler';
import type { WorkflowEntryCoordinator } from '../../../src/telegram/interfaces/workflow-entry.coordinator';
import type { WorkflowNavigationHandler } from '../../../src/telegram/interfaces/workflow-navigation.handler';

const copy = catalogFor('en').camera.sources;
const home = catalogFor('en').home.common;

const receipt = {
  id: 'abcdefghijklmnop',
  userId: 100,
  chatId: 42,
  kind: 'workflow-return',
  sessionToken: null,
  status: 'pending',
  expiresAt: new Date('2030-01-01'),
  payload: {
    workflow: 'camera',
    phase: 'cancellable',
    originSource: 'captured',
    origin: { kind: 'sensors', page: 1 },
  },
} satisfies WorkflowReturnReceipt;

const NETWORK = { family: 4, cidr: '192.168.1.0/24', interface: 'eth0' } as const;

function overviewSource(overrides: Partial<RtspSourceOverview> = {}): RtspSourceOverview {
  return {
    cameraId: 'camera-with-private-id',
    cameraName: 'Front door',
    summary: {
      scheme: 'rtsp',
      host: 'camera.local:554',
      transport: 'tcp',
      tlsMode: 'none',
      profile: 'eco',
      substreamHost: null,
      ready: true,
    },
    hasCredential: true,
    revision: 4,
    verifiedAt: new Date('2026-07-01'),
    policyDigest: 'digest',
    relationship: 'allowed',
    operationalState: 'configured-verified',
    currentPolicyDigest: 'digest',
    needsReverification: false,
    ...overrides,
  };
}

function overviewPage(overrides: Partial<RtspSourcesOverviewPage> = {}): RtspSourcesOverviewPage {
  return {
    policy: { state: 'ready', networks: [NETWORK] },
    sources: [],
    attachCandidates: [],
    page: 1,
    pageCount: 1,
    ...overrides,
  };
}

/** Distinctly named sources, so paging and per-row identity stay visible. */
function manySources(count: number): RtspSourceOverview[] {
  return Array.from({ length: count }, (_, index) =>
    overviewSource({
      cameraId: `camera-private-id-${index}`,
      cameraName: `Camera ${index}`,
    }),
  );
}

interface CameraRow {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  config: null;
}

/**
 * The Camera use case is stubbed by paging `sources` with whatever `pageSize`
 * the handler actually asks for — so a handler that asked for a different page
 * size would render a different number of rows, and the row-count assertions
 * would fail rather than pass on a stub that ignored the request.
 */
function setup(
  options: {
    availability?: FeatureAvailabilityPort;
    pages?: RtspSourcesOverviewPage[];
    sources?: RtspSourceOverview[];
    cameras?: CameraRow[];
  } = {},
) {
  const all = options.sources ?? [];
  const overview = {
    execute: vi.fn(async (request: { page?: number; pageSize?: number } = {}) => {
      if (options.pages) return options.pages.shift() ?? overviewPage();
      const size = request.pageSize ?? 5;
      const pageCount = Math.max(1, Math.ceil(all.length / size));
      const page = Math.min(Math.max(request.page ?? 1, 1), pageCount);
      return overviewPage({
        sources: all.slice((page - 1) * size, page * size),
        page,
        pageCount,
      });
    }),
  };
  const cameras = {
    execute: vi.fn().mockResolvedValue(
      options.cameras ?? [
        {
          id: 'camera-with-private-id',
          name: 'Front door',
          type: RTSP_SOURCE_CAMERA_TYPE,
          enabled: true,
          config: null,
        },
      ],
    ),
  };
  const workflows = {
    begin: vi.fn().mockResolvedValue(receipt),
    validateCurrent: vi.fn().mockResolvedValue(true),
    markRunning: vi.fn().mockResolvedValue(true),
  };
  const navigation = {
    complete: vi.fn(async (_ctx, _launch, presentation) => {
      await presentation.deliver();
    }),
  };
  // A real clock, not a frozen one: the screen's ten-minute window is measured
  // against `ClockPort`, so a constant `now` would make every expiry branch
  // unreachable and every TTL assertion vacuous.
  let nowMs = new Date('2026-07-17T00:00:00Z').getTime();
  const advance = (ms: number) => {
    nowMs += ms;
  };
  const handler = new CameraSourcesHandler(
    overview as never,
    cameras as never,
    { now: () => new Date(nowMs) },
    workflows as unknown as WorkflowEntryCoordinator,
    navigation as unknown as WorkflowNavigationHandler,
    options.availability,
  );
  return { advance, cameras, handler, navigation, overview, workflows };
}

function context(input: { text?: string; role?: 'admin' | 'user'; messageId?: number } = {}) {
  return {
    from: { id: 100 },
    chat: { id: 42, type: 'private' },
    message: input.text === undefined ? undefined : { message_id: input.messageId ?? 71, text: input.text },
    localeState: {
      locale: 'en',
      catalog: catalogFor('en'),
      user: { telegramId: 100, role: input.role ?? 'admin' },
    },
    reply: vi.fn().mockResolvedValue({ message_id: 9 }),
    api: { deleteMessage: vi.fn().mockResolvedValue(true) },
  };
}

interface RenderedButton {
  text: string;
  callback_data: string;
}

function buttons(options: unknown): RenderedButton[] {
  if (!isRecord(options) || !isRecord(options.reply_markup) || !Array.isArray(options.reply_markup.inline_keyboard))
    return [];
  return options.reply_markup.inline_keyboard.flatMap((row) =>
    Array.isArray(row)
      ? row.flatMap((button) =>
          isRecord(button) && typeof button.callback_data === 'string' && typeof button.text === 'string'
            ? [{ text: button.text, callback_data: button.callback_data }]
            : [],
        )
      : [],
  );
}

/** Buttons of one rendered screen, counted from the first reply of the test. */
function screen(ctx: ReturnType<typeof context>, index: number): RenderedButton[] {
  return buttons((ctx.reply.mock.calls[index] as unknown[])[1]);
}

function body(ctx: ReturnType<typeof context>, index: number): string {
  return String((ctx.reply.mock.calls[index] as unknown[])[0]);
}

function bodies(ctx: ReturnType<typeof context>): string {
  return (ctx.reply.mock.calls as unknown[][]).map((call) => String(call[0])).join('\n');
}

function keyboardData(ctx: ReturnType<typeof context>): string[] {
  return (ctx.reply.mock.calls as unknown[][]).flatMap((call) =>
    buttons(call[1]).map((button) => button.callback_data),
  );
}

function labels(ctx: ReturnType<typeof context>): string[] {
  return (ctx.reply.mock.calls as unknown[][]).flatMap((call) => buttons(call[1]).map((button) => button.text));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The action half of a rendered `cam:<receipt>:src:<action>` callback. */
function action(data: string): string {
  return data.split(':src:')[1];
}

describe('CameraSourcesHandler status-first overview', () => {
  it('opens on the empty state with one primary Add first camera action, Back and Home', async () => {
    const { handler, overview } = setup({ sources: [] });
    const ctx = context();

    await handler.handleEntry(ctx as never, { receipt });

    expect(overview.execute).toHaveBeenCalledWith({ page: 1, pageSize: 8 });
    expect(body(ctx, 0)).toContain(copy.overview.title);
    expect(body(ctx, 0)).toContain(copy.policy.scope);
    expect(body(ctx, 0)).toContain(copy.policy.network(NETWORK));
    expect(body(ctx, 0)).toContain(copy.policy.state.ready);
    expect(body(ctx, 0)).toContain(copy.emptyState.title);
    expect(body(ctx, 0)).toContain(copy.emptyState.body);

    const rendered = screen(ctx, 0);
    expect(rendered.filter((button) => button.text === copy.emptyState.addFirst)).toHaveLength(1);
    expect(rendered.map((button) => button.text)).not.toContain(copy.overview.addCamera);
    expect(rendered.map((button) => button.callback_data)).toEqual(
      expect.arrayContaining(['wr:abcdefghijklmnop:o', 'wr:abcdefghijklmnop:h']),
    );
    expect(rendered.map((button) => button.text)).toEqual(
      expect.arrayContaining([home.back, home.home]),
    );
  });

  it('renders no Add/Edit/Test/List/Remove operation picker', async () => {
    const { handler } = setup({ sources: [overviewSource()] });
    const ctx = context();

    await handler.handleEntry(ctx as never, { receipt });

    const data = keyboardData(ctx);
    // The picker's own callbacks, so a button left in an old chat message
    // resolves to nothing rather than to a different operation.
    for (const legacy of ['a', 'e', 't', 'l', 'r', 'c', 's:AAAAAAAAAAAA']) {
      expect(data, legacy).not.toContain(`cam:abcdefghijklmnop:src:${legacy}`);
    }
    expect(labels(ctx)).not.toContain('➕ Add');
    expect(labels(ctx)).not.toContain('✏️ Edit');
    expect(labels(ctx)).not.toContain('🧪 Test & update');
    expect(labels(ctx)).not.toContain('📋 List');
    expect(labels(ctx)).not.toContain('🗑 Remove');
    expect(bodies(ctx)).not.toContain('Choose an action:');
  });

  it('renders eight localized source rows per page with a next page control and no camera ids', async () => {
    const { handler, overview } = setup({ sources: manySources(20) });
    const ctx = context();

    await handler.handleEntry(ctx as never, { receipt });

    expect(overview.execute).toHaveBeenCalledWith({ page: 1, pageSize: 8 });
    const rendered = screen(ctx, 0);
    expect(rendered.filter((button) => button.callback_data.includes(':src:d:'))).toHaveLength(8);
    expect(rendered.map((button) => button.text)).toContain(
      copy.row({ cameraName: 'Camera 0', status: copy.statuses['configured-verified'] }),
    );
    expect(rendered.map((button) => button.text)).toContain(copy.overview.addCamera);
    expect(rendered.map((button) => button.text)).toContain(copy.overview.next);
    expect(rendered.map((button) => button.text)).not.toContain(copy.overview.previous);
    expect(rendered.map((button) => button.callback_data)).toContain('cam:abcdefghijklmnop:src:p:2');
    expect(body(ctx, 0)).toContain(copy.overview.page(1, 3));

    expect(JSON.stringify(ctx.reply.mock.calls)).not.toContain('camera-private-id-');
    expect(keyboardData(ctx).every((value) => Buffer.byteLength(value, 'utf8') <= 64)).toBe(true);
  });

  it('pages forward and back over the same eight-row window', async () => {
    const { handler, overview } = setup({ sources: manySources(20) });
    const ctx = context();
    await handler.handleEntry(ctx as never, { receipt });

    await handler.handleCallback(ctx as never, 'p:2', receipt);

    expect(overview.execute).toHaveBeenLastCalledWith({ page: 2, pageSize: 8 });
    const second = screen(ctx, 1).map((button) => button.callback_data);
    expect(second.filter((value) => value.includes(':src:d:'))).toHaveLength(8);
    expect(second).toContain('cam:abcdefghijklmnop:src:p:1');
    expect(second).toContain('cam:abcdefghijklmnop:src:p:3');
    expect(screen(ctx, 1).map((button) => button.text)).toContain(copy.overview.previous);
    expect(body(ctx, 1)).toContain(copy.overview.page(2, 3));

    await handler.handleCallback(ctx as never, 'p:3', receipt);
    const third = screen(ctx, 2).map((button) => button.callback_data);
    expect(third.filter((value) => value.includes(':src:d:'))).toHaveLength(4);
    expect(third).not.toContain('cam:abcdefghijklmnop:src:p:4');
    expect(screen(ctx, 2).map((button) => button.text)).not.toContain(copy.overview.next);
  });

  it('renders the policy scope and every installed network on a populated page', async () => {
    const ipv6 = { family: 6, cidr: 'fd00::/64', interface: 'eth1' } as const;
    const { handler } = setup({
      pages: [
        overviewPage({
          sources: [overviewSource()],
          policy: { state: 'stale', networks: [NETWORK, ipv6] },
        }),
      ],
    });
    const ctx = context();

    await handler.handleEntry(ctx as never, { receipt });

    expect(body(ctx, 0)).toContain(copy.policy.scope);
    expect(body(ctx, 0)).toContain(copy.policy.network(NETWORK));
    expect(body(ctx, 0)).toContain(copy.policy.network(ipv6));
    expect(body(ctx, 0)).toContain(copy.policy.state.stale);
    expect(body(ctx, 0)).not.toContain(copy.policy.state.ready);
  });

  it('says so when the policy describes no network at all', async () => {
    const { handler } = setup({
      pages: [overviewPage({ policy: { state: 'unavailable', networks: [] } })],
    });
    const ctx = context();

    await handler.handleEntry(ctx as never, { receipt });

    expect(body(ctx, 0)).toContain(copy.policy.noNetworks);
    expect(body(ctx, 0)).toContain(copy.policy.state.unavailable);
  });

  it('omits the page line for a library that fits on one page', async () => {
    const { handler } = setup({ sources: manySources(8) });
    const ctx = context();

    await handler.handleEntry(ctx as never, { receipt });

    expect(body(ctx, 0)).not.toContain(copy.overview.page(1, 1));
    expect(screen(ctx, 0).map((button) => button.text)).not.toContain(copy.overview.next);
  });

  it('keeps every rendered callback inside Telegram limits, overview and detail alike', async () => {
    const { handler } = setup({ sources: manySources(20) });
    const ctx = context();
    await handler.handleEntry(ctx as never, { receipt });
    const opener = screen(ctx, 0).find((button) => button.callback_data.includes(':src:d:'));

    await handler.handleCallback(ctx as never, action(opener!.callback_data), receipt);

    const data = keyboardData(ctx);
    expect(data.length).toBeGreaterThan(10);
    for (const value of data) {
      expect(Buffer.byteLength(value, 'utf8'), value).toBeLessThanOrEqual(64);
    }
    // The widest page number a callback could ever carry still fits.
    expect(
      Buffer.byteLength(`cam:${receipt.id}:src:p:${Number.MAX_SAFE_INTEGER}`, 'utf8'),
    ).toBeLessThanOrEqual(64);
  });
});

describe('CameraSourcesHandler source detail', () => {
  /** Opens the single source's detail and returns the context it rendered into. */
  async function openDetail(handler: CameraSourcesHandler) {
    const ctx = context();
    await handler.handleEntry(ctx as never, { receipt });
    const opener = screen(ctx, 0).find((button) => button.callback_data.includes(':src:d:'));
    if (!opener) throw new Error('the overview rendered no source row');
    await handler.handleCallback(ctx as never, action(opener.callback_data), receipt);
    return ctx;
  }

  it('shows the display name, redacted host, status and network, never the camera id', async () => {
    const { handler } = setup({
      sources: [
        overviewSource({
          operationalState: 'needs-attention',
          relationship: 'blocked',
          needsReverification: true,
        }),
      ],
    });

    const ctx = await openDetail(handler);

    expect(body(ctx, 1)).toContain(
      copy.detail({
        cameraName: 'Front door',
        host: 'camera.local:554',
        status: copy.statuses['needs-attention'],
        relationship: copy.relationships.blocked,
      }),
    );
    expect(body(ctx, 1)).toContain(copy.reverificationDue);
    expect(JSON.stringify(ctx.reply.mock.calls)).not.toContain('camera-with-private-id');
  });

  it('omits the reverification notice for a source verified under the policy in force', async () => {
    const { handler } = setup({ sources: [overviewSource()] });

    const ctx = await openDetail(handler);

    expect(body(ctx, 1)).not.toContain(copy.reverificationDue);
    expect(body(ctx, 1)).toContain(copy.statuses['configured-verified']);
  });

  it('offers Test connection, Change address, Details and a way back to the overview', async () => {
    const { handler } = setup({ sources: [overviewSource()] });

    const ctx = await openDetail(handler);

    const rendered = screen(ctx, 1);
    const texts = rendered.map((button) => button.text);
    expect(texts).toContain(copy.detailButtons.test);
    expect(texts).toContain(copy.detailButtons.changeAddress);
    expect(texts).toContain(copy.detailButtons.details);
    expect(texts).toContain(home.home);
    expect(rendered.map((button) => button.callback_data)).toContain('cam:abcdefghijklmnop:src:over');
    expect(rendered.map((button) => button.callback_data)).toContain('wr:abcdefghijklmnop:h');
  });

  it('names the removal after the camera when the camera exists only to carry the source', async () => {
    const { handler } = setup({ sources: [overviewSource()] });

    const ctx = await openDetail(handler);

    const texts = screen(ctx, 1).map((button) => button.text);
    expect(texts).toContain(copy.removal.removeCameraButton);
    expect(texts).not.toContain(copy.removal.removeSourceButton);
  });

  it('names the removal after the source when the source is attached to a real camera', async () => {
    const { handler } = setup({
      sources: [overviewSource()],
      cameras: [
        { id: 'camera-with-private-id', name: 'Front door', type: 'motion', enabled: true, config: null },
      ],
    });

    const ctx = await openDetail(handler);

    const texts = screen(ctx, 1).map((button) => button.text);
    expect(texts).toContain(copy.removal.removeSourceButton);
    expect(texts).not.toContain(copy.removal.removeCameraButton);
  });

  it('explains transport, quality, security and the policy relationship under Details', async () => {
    const { handler } = setup({ sources: [overviewSource()] });
    const ctx = await openDetail(handler);

    await handler.handleCallback(ctx as never, 'info', receipt);

    expect(body(ctx, 2)).toContain(copy.details.title);
    expect(body(ctx, 2)).toContain(copy.details.transports.tcp);
    expect(body(ctx, 2)).toContain(copy.details.profiles.eco);
    expect(body(ctx, 2)).toContain(copy.details.security.none);
    expect(body(ctx, 2)).toContain(copy.relationships.allowed);
    expect(JSON.stringify(ctx.reply.mock.calls)).not.toContain('camera-with-private-id');
  });

  it('returns to the remembered overview page from a detail, inside the ten-minute window', async () => {
    const { advance, handler, overview } = setup({ sources: manySources(20) });
    const ctx = context();
    await handler.handleEntry(ctx as never, { receipt });
    await handler.handleCallback(ctx as never, 'p:2', receipt);
    const opener = screen(ctx, 1).find((button) => button.callback_data.includes(':src:d:'));
    await handler.handleCallback(ctx as never, action(opener!.callback_data), receipt);
    advance(9 * 60_000);

    await handler.handleCallback(ctx as never, 'over', receipt);

    expect(overview.execute).toHaveBeenLastCalledWith({ page: 2, pageSize: 8 });
    expect(body(ctx, 3)).toContain(copy.overview.page(2, 3));
  });

  /*
   * The other side of the same window. Losing the remembered page costs a
   * reload and nothing else — which is the whole reason this screen keeps
   * navigation state rather than anything it would be dangerous to forget.
   */
  it('falls back to the first page once the remembered detail has expired', async () => {
    const { advance, handler, overview } = setup({ sources: manySources(20) });
    const ctx = context();
    await handler.handleEntry(ctx as never, { receipt });
    await handler.handleCallback(ctx as never, 'p:2', receipt);
    const opener = screen(ctx, 1).find((button) => button.callback_data.includes(':src:d:'));
    await handler.handleCallback(ctx as never, action(opener!.callback_data), receipt);
    advance(11 * 60_000);

    await handler.handleCallback(ctx as never, 'over', receipt);

    expect(overview.execute).toHaveBeenLastCalledWith({ page: 1, pageSize: 8 });
    expect(body(ctx, 3)).toContain(copy.overview.page(1, 3));
  });

  it('keeps the detail alive while the administrator reads its Details screen', async () => {
    const { advance, handler, overview } = setup({ sources: manySources(20) });
    const ctx = context();
    await handler.handleEntry(ctx as never, { receipt });
    await handler.handleCallback(ctx as never, 'p:2', receipt);
    const opener = screen(ctx, 1).find((button) => button.callback_data.includes(':src:d:'));
    await handler.handleCallback(ctx as never, action(opener!.callback_data), receipt);
    advance(9 * 60_000);
    await handler.handleCallback(ctx as never, 'info', receipt);
    advance(9 * 60_000);

    await handler.handleCallback(ctx as never, 'over', receipt);

    expect(overview.execute).toHaveBeenLastCalledWith({ page: 2, pageSize: 8 });
  });

  /*
   * `hasPending` is read across the handler boundary by
   * `CameraHandler.cancelExact`, whose `'missing'` answer is what raises the
   * `common.interrupted` notice. Viewing the screen now counts as pending —
   * the administrator does have a live screen — so both arms are pinned here.
   */
  it('reports a viewed screen as pending until its window closes', async () => {
    const { advance, handler } = setup({ sources: manySources(20) });
    const ctx = context();

    expect(handler.hasPending(100, 42, receipt.id)).toBe(false);

    await handler.handleEntry(ctx as never, { receipt });
    expect(handler.hasPending(100, 42, receipt.id)).toBe(true);
    expect(handler.hasPending(100, 42)).toBe(true);

    advance(9 * 60_000);
    expect(handler.hasPending(100, 42, receipt.id)).toBe(true);

    advance(2 * 60_000);
    expect(handler.hasPending(100, 42, receipt.id)).toBe(false);
    expect(handler.hasPending(100, 42)).toBe(false);
  });

  it('reloads the overview instead of acting when the selector no longer names a source', async () => {
    const { cameras, handler } = setup({ sources: [overviewSource()] });
    const ctx = context();
    await handler.handleEntry(ctx as never, { receipt });

    await handler.handleCallback(ctx as never, 'd:AAAAAAAAAAAA', receipt);

    expect(body(ctx, 1)).toContain(copy.overview.title);
    expect(screen(ctx, 1).map((button) => button.text)).not.toContain(copy.detailButtons.test);
    expect(cameras.execute).not.toHaveBeenCalled();
  });

  it('reloads the overview when Details is pressed without a remembered detail', async () => {
    const { handler } = setup({ sources: [overviewSource()] });
    const ctx = context();
    await handler.handleEntry(ctx as never, { receipt });

    await handler.handleCallback(ctx as never, 'info', receipt);

    expect(body(ctx, 1)).toContain(copy.overview.title);
    expect(body(ctx, 1)).not.toContain(copy.details.title);
  });
});

describe('CameraSourcesHandler entry gates', () => {
  function unavailable(state: 'installed-off' | 'needs-attention' = 'needs-attention'): FeatureAvailabilityPort {
    return {
      awaitInitialVerification: vi.fn(),
      inspect: vi.fn(),
      requireReady: vi.fn().mockRejectedValue(new FeatureUnavailableError('rtsp', state)),
    };
  }

  it('refuses a non-administrator and reads no source state at all', async () => {
    const { cameras, handler, overview } = setup({ sources: [overviewSource()] });
    const ctx = context({ role: 'user' });

    await handler.handleEntry(ctx as never, { receipt });

    expect(ctx.reply).toHaveBeenCalledWith(catalogFor('en').common.adminRequired);
    expect(overview.execute).not.toHaveBeenCalled();
    expect(cameras.execute).not.toHaveBeenCalled();
  });

  it('renders actionable feature copy instead of the overview when RTSP is not ready', async () => {
    const { handler, overview } = setup({ availability: unavailable(), sources: [overviewSource()] });
    const ctx = context();

    await handler.handleEntry(ctx as never, { receipt });

    const feature = catalogFor('en').feature;
    expect(ctx.reply).toHaveBeenCalledWith(feature.stale.attention(feature.names.rtsp));
    expect(overview.execute).not.toHaveBeenCalled();
    expect(bodies(ctx)).not.toContain(copy.overview.title);
  });

  it('keeps the same readiness gate on every source callback', async () => {
    const { handler, overview } = setup({
      availability: unavailable('installed-off'),
      sources: [overviewSource()],
    });
    const ctx = context();

    await handler.handleCallback(ctx as never, 'p:2', receipt);

    const feature = catalogFor('en').feature;
    expect(ctx.reply).toHaveBeenCalledWith(feature.stale.disabled(feature.names.rtsp));
    expect(overview.execute).not.toHaveBeenCalled();
  });

  it('refuses a non-administrator on a callback too', async () => {
    const { handler, overview } = setup({ sources: [overviewSource()] });
    const ctx = context({ role: 'user' });

    await handler.handleCallback(ctx as never, 'p:2', receipt);

    expect(ctx.reply).toHaveBeenCalledWith(catalogFor('en').common.adminRequired);
    expect(overview.execute).not.toHaveBeenCalled();
  });

  it('does not render the overview for a receipt that is no longer current', async () => {
    const { handler, overview, workflows } = setup({ sources: [overviewSource()] });
    workflows.validateCurrent.mockResolvedValueOnce(false);

    await handler.handleCallback(context() as never, 'p:2', receipt);

    expect(overview.execute).not.toHaveBeenCalled();
  });

  it('renders the RTSP-closed notice rather than a raw Camera rejection', async () => {
    const { handler, overview } = setup({ sources: [] });
    overview.execute.mockRejectedValueOnce(new CameraSourceUnavailableError('rtsp-closed'));
    const ctx = context();

    await handler.handleEntry(ctx as never, { receipt });

    expect(ctx.reply).toHaveBeenCalledWith(copy.rtspClosed);
  });

  it('renders presenter copy for an unclassified overview failure and never its message', async () => {
    const { handler, overview } = setup({ sources: [] });
    overview.execute.mockRejectedValueOnce(new Error('rtsp://user:pass@camera.local exploded'));
    const ctx = context();

    await handler.handleEntry(ctx as never, { receipt });

    const replies = JSON.stringify(ctx.reply.mock.calls);
    expect(replies).toContain(copy.errors['probe-failed']);
    expect(replies).not.toContain('user:pass');
    expect(replies).not.toMatch(/rtsps?:\/\//iu);
  });

  /*
   * The four actions this task renders but does not execute.
   *
   * This test is expected to FAIL the moment Task 5 wires `add` and Task 6
   * wires `test`/`addr`/`rm` — that is its job. Move an action out of this
   * list deliberately, in the commit that implements it, rather than
   * discovering later that one was wired by accident or never wired at all.
   */
  it('renders the Task 5 and Task 6 actions without executing anything', async () => {
    const { cameras, handler, overview } = setup({ sources: [overviewSource()] });
    const ctx = context();
    await handler.handleEntry(ctx as never, { receipt });
    const rendered = ctx.reply.mock.calls.length;
    const reads = overview.execute.mock.calls.length;

    for (const inert of ['add', 'test', 'addr', 'rm']) {
      await handler.handleCallback(ctx as never, inert, receipt);
    }

    expect(ctx.reply).toHaveBeenCalledTimes(rendered);
    expect(overview.execute).toHaveBeenCalledTimes(reads);
    expect(cameras.execute).not.toHaveBeenCalled();
  });

  it('claims no ordinary text message while no prompt exists', async () => {
    const { handler } = setup({ sources: [overviewSource()] });

    await expect(
      handler.handleText(context({ text: 'rtsp://user:pass@camera.local/live' }) as never),
    ).resolves.toBe(false);
  });
});
