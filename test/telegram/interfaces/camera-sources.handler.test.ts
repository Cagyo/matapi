import { Logger } from '@nestjs/common';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
  RtspSourceOverview,
  RtspSourcesOverviewPage,
} from '../../../src/camera/application/get-rtsp-source-overview.use-case';
import { RTSP_SOURCE_CAMERA_TYPE } from '../../../src/camera/domain/ports/rtsp-source-configuration.port';
import { CameraSourceUnavailableError } from '../../../src/camera/domain/errors/camera-source-unavailable.error';
import { CameraNameTakenError } from '../../../src/camera/domain/errors/camera-name-taken.error';
import { CameraNotFoundError } from '../../../src/camera/domain/errors/camera-not-found.error';
import { InvalidLiveSourceError } from '../../../src/camera/domain/errors/invalid-live-source.error';
import { LiveSourceAddressOutsidePolicyError } from '../../../src/camera/domain/errors/live-source-address-outside-policy.error';
import { LiveSourceAuthenticationRejectedError } from '../../../src/camera/domain/errors/live-source-authentication-rejected.error';
import { LiveSourceHostNotFoundError } from '../../../src/camera/domain/errors/live-source-host-not-found.error';
import { LiveSourceHostUnreachableError } from '../../../src/camera/domain/errors/live-source-host-unreachable.error';
import { LiveSourceProbeTimeoutError } from '../../../src/camera/domain/errors/live-source-probe-timeout.error';
import { LiveSourceStateChangedError } from '../../../src/camera/domain/errors/live-source-state-changed.error';
import { LiveSourceTlsVerificationError } from '../../../src/camera/domain/errors/live-source-tls-verification.error';
import { LiveSourceUnsupportedStreamError } from '../../../src/camera/domain/errors/live-source-unsupported-stream.error';
import type { RedactedLiveSource } from '../../../src/camera/domain/ports/live-source-repository.port';
import * as schema from '../../../src/database/schema';
import { FeatureUnavailableError } from '../../../src/features/domain/errors/feature-unavailable.error';
import { RtspPolicyDigestMismatchError } from '../../../src/features/domain/errors/rtsp-policy-digest-mismatch.error';
import type { FeatureAvailabilityPort } from '../../../src/features/domain/ports/feature-availability.port';
import { catalogFor } from '../../../src/locales';
import { CameraSourceMessageDeletionError } from '../../../src/telegram/application/ports/camera-source-message.port';
import type { CameraSourcePromptRepositoryPort } from '../../../src/telegram/application/ports/camera-source-prompt-repository.port';
import {
  CAMERA_SOURCE_PROMPT_TTL_MS,
  type CameraSourcePrompt,
} from '../../../src/telegram/domain/camera-source-prompt';
import type { WorkflowReturnReceipt } from '../../../src/telegram/domain/workflow-return';
import { DrizzleCameraSourcePromptRepository } from '../../../src/telegram/infrastructure/drizzle-camera-source-prompt.repository';
import { InMemoryCameraSourcePromptRepository } from '../../../src/telegram/infrastructure/in-memory-camera-source-prompt.repository';
import { CameraSourcesHandler } from '../../../src/telegram/interfaces/camera-sources.handler';
import type { WorkflowEntryCoordinator } from '../../../src/telegram/interfaces/workflow-entry.coordinator';
import type { WorkflowNavigationHandler } from '../../../src/telegram/interfaces/workflow-navigation.handler';

/**
 * The one value that must never survive a credential reply, in the two shapes a
 * leak would take: the whole address, and the password on its own.
 */
const SECRET_URL = 'rtsp://operator:hunter2@camera.local:554/stream1';
const SECRET_PASSWORD = 'hunter2';

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

/** What `CreateRtspCameraUseCase`/`AttachRtspSourceUseCase` hand back. */
function installedSource(overrides: Partial<RedactedLiveSource> = {}): RedactedLiveSource {
  const { relationship: _r, operationalState: _o, currentPolicyDigest: _c, needsReverification: _n, ...base } =
    overviewSource();
  return { ...base, ...overrides };
}

/**
 * The real in-memory port implementation, with every call recorded.
 *
 * The recording matters more than the spying: `created` is every value this
 * handler ever asked the repository to persist, so a plaintext address that
 * reached a durable row would be visible here even if it never reached SQLite.
 */
function promptStore(inner: CameraSourcePromptRepositoryPort = new InMemoryCameraSourcePromptRepository()) {
  const created: CameraSourcePrompt[] = [];
  return {
    created,
    inner,
    createPending: vi.fn(async (prompt: CameraSourcePrompt) => {
      created.push(prompt);
      await inner.createPending(prompt);
    }),
    claimReply: vi.fn((input: Parameters<CameraSourcePromptRepositoryPort['claimReply']>[0]) =>
      inner.claimReply(input)),
    consume: vi.fn((input: Parameters<CameraSourcePromptRepositoryPort['consume']>[0]) => inner.consume(input)),
    expire: vi.fn((input: Parameters<CameraSourcePromptRepositoryPort['expire']>[0]) => inner.expire(input)),
    listRunning: vi.fn((limit: number) => inner.listRunning(limit)),
    prune: vi.fn((now: Date) => inner.prune(now)),
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
    attachCandidates?: { cameraId: string; cameraName: string }[];
    prompts?: ReturnType<typeof promptStore>;
    /** What the Camera boundary reports it actually retired. */
    removed?: 'camera' | 'source';
    /** Omitted to prove the screen survives an unwired feature handoff. */
    features?: false;
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
        attachCandidates: options.attachCandidates ?? [],
        page,
        pageCount,
      });
    }),
  };
  const prompts = options.prompts ?? promptStore();
  const messages = { delete: vi.fn().mockResolvedValue(undefined) };
  const createRtspCamera = { execute: vi.fn().mockResolvedValue(installedSource()) };
  const attachRtspSource = { execute: vi.fn().mockResolvedValue(installedSource()) };
  const replaceRtspSource = { execute: vi.fn().mockResolvedValue(installedSource()) };
  const testRtspSource = { execute: vi.fn().mockResolvedValue(installedSource()) };
  const removeRtspSource = {
    execute: vi.fn().mockResolvedValue({ removed: options.removed ?? 'camera' }),
  };
  const features = { handleRtspReinstallEntry: vi.fn().mockResolvedValue(undefined) };
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
    createRtspCamera as never,
    attachRtspSource as never,
    replaceRtspSource as never,
    testRtspSource as never,
    removeRtspSource as never,
    prompts,
    messages,
    { now: () => new Date(nowMs) },
    workflows as unknown as WorkflowEntryCoordinator,
    navigation as unknown as WorkflowNavigationHandler,
    options.availability,
    options.features === false ? undefined : (features as never),
  );
  return {
    advance,
    attachRtspSource,
    cameras,
    createRtspCamera,
    features,
    handler,
    messages,
    navigation,
    overview,
    prompts,
    removeRtspSource,
    replaceRtspSource,
    testRtspSource,
    workflows,
  };
}

/**
 * Prompt messages get real, distinct identifiers.
 *
 * A constant `message_id` would make every exact-reply assertion in this file
 * vacuous: a handler that bound a reply to *any* prompt rather than to the one
 * it answers would still pass, because every prompt would carry the same
 * number. The counter is module-wide, so no two prompts in a run collide.
 */
let nextPromptMessageId = 1000;

function context(
  input: {
    text?: string;
    role?: 'admin' | 'user';
    messageId?: number;
    /** `message_id` of the prompt this message replies to. */
    replyTo?: number;
    chatType?: string;
    userId?: number;
    chatId?: number;
  } = {},
) {
  const sent: number[] = [];
  return {
    sent,
    from: { id: input.userId ?? 100 },
    chat: { id: input.chatId ?? 42, type: input.chatType ?? 'private' },
    message: input.text === undefined
      ? undefined
      : {
          message_id: input.messageId ?? 71,
          text: input.text,
          ...(input.replyTo === undefined ? {} : { reply_to_message: { message_id: input.replyTo } }),
        },
    localeState: {
      locale: 'en',
      catalog: catalogFor('en'),
      user: { telegramId: input.userId ?? 100, role: input.role ?? 'admin' },
    },
    reply: vi.fn(async () => {
      const messageId = (nextPromptMessageId += 1);
      sent.push(messageId);
      return { message_id: messageId };
    }),
    api: { deleteMessage: vi.fn().mockResolvedValue(true) },
  };
}

/**
 * Everything a log line could carry, at every level either logger offers.
 *
 * This file is the one place in the codebase where an added log statement is a
 * credential disclosure, and nothing else would catch one: the handler has no
 * logger today, so there is no existing spy for a new line to fall under.
 * Both Nest levels — instance and static, because `Logger.log()` bypasses a
 * prototype spy — and the console are captured, and the levels are read off the
 * objects rather than listed, so a level added by a Nest upgrade is covered
 * without this list being remembered.
 */
function captureLogs(): { lines: unknown[]; restore: () => void } {
  const lines: unknown[] = [];
  const record = (...args: unknown[]) => {
    lines.push(...args);
  };
  const spies = [
    ...['log', 'warn', 'error', 'debug', 'verbose', 'fatal']
      .filter((level) => typeof (Logger.prototype as never as Record<string, unknown>)[level] === 'function')
      .map((level) => vi.spyOn(Logger.prototype as never, level as never).mockImplementation(record as never)),
    ...['log', 'warn', 'error', 'debug', 'verbose', 'fatal']
      .filter((level) => typeof (Logger as never as Record<string, unknown>)[level] === 'function')
      .map((level) => vi.spyOn(Logger as never, level as never).mockImplementation(record as never)),
    ...['log', 'warn', 'error', 'debug', 'info', 'trace']
      .filter((level) => typeof (console as never as Record<string, unknown>)[level] === 'function')
      .map((level) => vi.spyOn(console as never, level as never).mockImplementation(record as never)),
  ];
  return {
    lines,
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

/**
 * Captured log arguments as searchable text. An `Error` is unwrapped rather
 * than serialized: `JSON.stringify(new Error(url))` is `{}`, so a logged
 * rejection carrying an address would otherwise scan clean.
 */
function transcript(lines: readonly unknown[]): string {
  return lines
    .map((line) => {
      if (line instanceof Error) return `${line.name}: ${line.message}\n${line.stack ?? ''}`;
      if (typeof line === 'string') return line;
      return JSON.stringify(line) ?? String(line);
    })
    .join('\n');
}

/** The `message_id` of the last message this context sent. */
function lastSent(ctx: ReturnType<typeof context>): number {
  const id = ctx.sent.at(-1);
  if (id === undefined) throw new Error('the handler sent no message');
  return id;
}

/**
 * Every string still reachable from an object, however it is held.
 *
 * `JSON.stringify` is the wrong tool for a retention scan and the reason is
 * specific: it renders a `Map` as `{}` and a `Set` as `{}`. The view state this
 * handler keeps is a `Map`, which is exactly where a future "retry with the
 * same address" feature would stash one — so a `JSON.stringify` scan is blind
 * to the most likely leak there is. This walks the graph instead.
 *
 * Functions are skipped deliberately, and that is what keeps the scan honest
 * rather than merely broad: `createRtspCamera.execute` is a spy whose recorded
 * calls contain the address legitimately, and walking into it would make every
 * assertion below fail for the one reason that is not a leak.
 */
function reachableStrings(root: unknown, budget = 8, seen = new WeakSet<object>()): string[] {
  if (typeof root === 'string') return [root];
  if (budget <= 0 || typeof root !== 'object' || root === null) return [];
  if (seen.has(root)) return [];
  seen.add(root);
  const children: unknown[] = root instanceof Map
    ? [...root.keys(), ...root.values()]
    : root instanceof Set
      ? [...root.values()]
      : Array.isArray(root)
        ? root
        : Object.values(root);
  return children.flatMap((child) => reachableStrings(child, budget - 1, seen));
}

/** Every reply and every button label this context has rendered, as one string. */
function sentJson(ctx: ReturnType<typeof context>): string {
  return JSON.stringify(ctx.reply.mock.calls);
}

function markup(ctx: ReturnType<typeof context>, index: number): unknown {
  const options = (ctx.reply.mock.calls[index] as unknown[])[1];
  return isRecord(options) ? options.reply_markup : undefined;
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
   * The inert list is now empty: `add` left it in Task 5 and `test`/`addr`/`rm`
   * leave it here. What replaces it is the same guarantee stated the other way
   * round — every action the detail screen renders reaches an implementation,
   * so a control cannot be added to the keyboard and left unrouted.
   *
   * `rm` is deliberately the confirmation screen rather than the removal: the
   * only callback that retires anything is `rm:y:<selector>:<revision>`, and it
   * exists only on a screen that was rendered from a fresh read.
   */
  it('routes every control the detail screen renders', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const opened = context();
    await bench.handler.handleEntry(opened as never, { receipt });
    const opener = screen(opened, 0).find((button) => button.callback_data.includes(':src:d:'));
    await bench.handler.handleCallback(opened as never, action(opener!.callback_data), receipt);
    const rendered = screen(opened, 1)
      .map((button) => button.callback_data)
      .filter((data) => data.includes(':src:'));
    expect(rendered.length).toBeGreaterThanOrEqual(5);

    for (const data of rendered) {
      // Each control is pressed from a freshly opened detail, so one that
      // consumed the screen cannot make the next one look routed.
      const ctx = context();
      await bench.handler.handleEntry(ctx as never, { receipt });
      await bench.handler.handleCallback(ctx as never, action(opener!.callback_data), receipt);
      const before = ctx.reply.mock.calls.length;
      await bench.handler.handleCallback(ctx as never, action(data), receipt);
      expect(ctx.reply.mock.calls.length, data).toBeGreaterThan(before);
    }
    // Rendering a control is not executing one: reaching the confirmation is
    // the whole of what `rm` does.
    expect(bench.removeRtspSource.execute).not.toHaveBeenCalled();
  });

  it('claims no ordinary text message while no prompt exists', async () => {
    const { handler } = setup({ sources: [overviewSource()] });

    await expect(
      handler.handleText(context({ text: 'rtsp://user:pass@camera.local/live' }) as never),
    ).resolves.toBe(false);
  });
});

/*
 * ─── Exact ForceReply conversations ────────────────────────────────────────
 *
 * Everything below turns on one ordering, and it is the reason this file
 * carries a real prompt repository rather than a stub: a credential reply is
 * deleted before anything is allowed to decide it was not worth deleting.
 */

const NOW = new Date('2026-07-17T00:00:00Z');
/*
 * The name these conversations propose. Deliberately *not* the fixture
 * camera's 'Front door': that one is already taken, and proposing it exercises
 * the advisory uniqueness check rather than the path under test.
 */
const NEW_CAMERA = 'Side gate';
const CANDIDATES = [
  { cameraId: 'camera-hallway-private-id', cameraName: 'Hallway' },
  { cameraId: 'camera-yard-private-id', cameraName: 'Back yard' },
];

type Bench = ReturnType<typeof setup>;

/** Opens Sources and presses Add, which asks for a name when nothing can be attached. */
async function openNamePrompt(bench: Bench) {
  const ctx = context();
  await bench.handler.handleEntry(ctx as never, { receipt });
  await bench.handler.handleCallback(ctx as never, 'add', receipt);
  return { ctx, promptMessageId: lastSent(ctx) };
}

/**
 * Drives a create as far as the address prompt, and reports that prompt's id.
 *
 * `openCredentialPromptOn` is the same thing driven on a context that has
 * already opened the screen, so the page the administrator was on is the page
 * the prompt carries — which is what the navigation-state assertions turn on.
 *
 * The name half of the conversation claims and consumes a prompt of its own, so
 * its history is cleared here: a test about the *credential* reply that counted
 * those calls would be measuring this helper rather than the handler.
 * `invocationCallOrder` keeps counting across the reset, so ordering assertions
 * still compare the real sequence.
 */
async function openCredentialPromptOn(bench: Bench, opener: ReturnType<typeof context>) {
  const naming = context({ text: 'Side gate', messageId: 500, replyTo: lastSent(opener) });
  await bench.handler.handleText(naming as never);
  bench.prompts.claimReply.mockClear();
  bench.prompts.consume.mockClear();
  bench.messages.delete.mockClear();
  bench.navigation.complete.mockClear();
  return { ctx: naming, promptMessageId: lastSent(naming) };
}

async function openCredentialPrompt(bench: Bench, name = 'Side gate') {
  const opened = await openNamePrompt(bench);
  const naming = context({ text: name, messageId: 500, replyTo: opened.promptMessageId });
  await bench.handler.handleText(naming as never);
  bench.prompts.claimReply.mockClear();
  bench.prompts.consume.mockClear();
  bench.messages.delete.mockClear();
  return { ctx: naming, promptMessageId: lastSent(naming) };
}

/** Replies to an address prompt with an address, as the administrator by default. */
async function answerAddress(
  bench: Bench,
  promptMessageId: number,
  options: { text?: string; role?: 'admin' | 'user'; messageId?: number } = {},
) {
  const ctx = context({
    text: options.text ?? SECRET_URL,
    replyTo: promptMessageId,
    messageId: options.messageId ?? 600,
    role: options.role,
  });
  const claimed = await bench.handler.handleText(ctx as never);
  return { ctx, claimed };
}

describe('CameraSourcesHandler add', () => {
  it('offers Create and Attach only while some camera could take a source', async () => {
    const bench = setup({ sources: [overviewSource()], attachCandidates: CANDIDATES });
    const ctx = context();
    await bench.handler.handleEntry(ctx as never, { receipt });

    await bench.handler.handleCallback(ctx as never, 'add', receipt);

    expect(body(ctx, 1)).toContain(copy.add.title);
    expect(body(ctx, 1)).toContain(copy.add.choose);
    const rendered = screen(ctx, 1);
    expect(rendered.map((button) => button.text)).toEqual(
      expect.arrayContaining([copy.add.create, copy.add.attach]),
    );
    expect(rendered.map((button) => button.callback_data)).toEqual(
      expect.arrayContaining([
        'cam:abcdefghijklmnop:src:add:c',
        'cam:abcdefghijklmnop:src:add:a',
        'cam:abcdefghijklmnop:src:over',
        'wr:abcdefghijklmnop:h',
      ]),
    );
    // The fork is a screen, not a prompt: nothing durable exists yet.
    expect(bench.prompts.createPending).not.toHaveBeenCalled();
    expect(bodies(ctx)).not.toContain(copy.prompts.name);
  });

  it('asks for the display name at once when no camera could be attached to', async () => {
    const bench = setup({ sources: [overviewSource()] });

    const { ctx, promptMessageId } = await openNamePrompt(bench);

    expect(body(ctx, 1)).toContain(copy.prompts.name);
    expect(body(ctx, 1)).toContain(copy.prompts.nameHint);
    expect(body(ctx, 1)).toContain(copy.prompts.replyHint);
    expect(markup(ctx, 1)).toEqual({ force_reply: true, selective: true });
    expect(labels(ctx)).not.toContain(copy.add.create);
    expect(labels(ctx)).not.toContain(copy.add.attach);
    expect(bench.prompts.created).toEqual([
      {
        userId: 100,
        chatId: 42,
        receiptId: receipt.id,
        promptMessageId,
        replyMessageId: null,
        phase: 'name',
        operation: 'create',
        cameraId: null,
        displayName: null,
        expectedRevision: null,
        status: 'pending',
        deletionFailed: false,
        expiresAt: new Date(NOW.getTime() + CAMERA_SOURCE_PROMPT_TTL_MS),
        retainUntil: null,
      },
    ]);
  });

  it('asks for the display name when Create is chosen at the fork', async () => {
    const bench = setup({ sources: [overviewSource()], attachCandidates: CANDIDATES });
    const ctx = context();
    await bench.handler.handleEntry(ctx as never, { receipt });
    await bench.handler.handleCallback(ctx as never, 'add', receipt);

    await bench.handler.handleCallback(ctx as never, 'add:c', receipt);

    expect(body(ctx, 2)).toContain(copy.prompts.name);
    expect(markup(ctx, 2)).toEqual({ force_reply: true, selective: true });
    expect(bench.prompts.created).toHaveLength(1);
    expect(bench.prompts.created[0].phase).toBe('name');
  });

  it('lists attachable cameras by name behind opaque selectors', async () => {
    const bench = setup({ sources: [overviewSource()], attachCandidates: CANDIDATES });
    const ctx = context();
    await bench.handler.handleEntry(ctx as never, { receipt });
    await bench.handler.handleCallback(ctx as never, 'add', receipt);

    await bench.handler.handleCallback(ctx as never, 'add:a', receipt);

    expect(body(ctx, 2)).toContain(copy.add.chooseCamera);
    const rendered = screen(ctx, 2);
    expect(rendered.map((button) => button.text)).toEqual(
      expect.arrayContaining(['Hallway', 'Back yard']),
    );
    expect(rendered.filter((button) => button.callback_data.includes(':src:add:s:'))).toHaveLength(2);
    expect(sentJson(ctx)).not.toContain('camera-hallway-private-id');
    expect(sentJson(ctx)).not.toContain('camera-yard-private-id');
    for (const button of rendered) {
      expect(Buffer.byteLength(button.callback_data, 'utf8'), button.callback_data).toBeLessThanOrEqual(64);
    }
  });

  it('warns about schemes, networks, credentials, Telegram, deletion and the window before asking for an address', async () => {
    const bench = setup({ sources: [overviewSource()], attachCandidates: CANDIDATES });
    const ctx = context();
    await bench.handler.handleEntry(ctx as never, { receipt });
    await bench.handler.handleCallback(ctx as never, 'add', receipt);
    await bench.handler.handleCallback(ctx as never, 'add:a', receipt);
    const chosen = screen(ctx, 2).find((button) => button.callback_data.includes(':src:add:s:'));

    await bench.handler.handleCallback(ctx as never, action(chosen!.callback_data), receipt);

    // The notice is the exact copy, with the networks in force and the window
    // taken from the model's TTL — not a number written a second time here.
    expect(body(ctx, 3)).toBe(
      copy.privacyNotice({
        networks: copy.policy.network(NETWORK),
        minutes: CAMERA_SOURCE_PROMPT_TTL_MS / 60_000,
      }),
    );
    // The six promises it makes, each read out of the rendered string.
    expect(body(ctx, 3)).toContain('RTSP');
    expect(body(ctx, 3)).toContain('RTSPS');
    expect(body(ctx, 3)).toContain(copy.policy.network(NETWORK));
    expect(body(ctx, 3)).toMatch(/username and password/u);
    expect(body(ctx, 3)).toMatch(/Telegram has no secret channel/u);
    expect(body(ctx, 3)).toMatch(/best effort/u);
    expect(body(ctx, 3)).toMatch(/10 minutes/u);
    // And it arrives before the control that invites the address, not after.
    expect(body(ctx, 4)).toContain(copy.prompts.credential);
    expect(markup(ctx, 3)).toBeUndefined();
    expect(markup(ctx, 4)).toEqual({ force_reply: true, selective: true });
  });

  it('persists only the chosen camera and its name for an attach', async () => {
    const bench = setup({ sources: [overviewSource()], attachCandidates: CANDIDATES });
    const ctx = context();
    await bench.handler.handleEntry(ctx as never, { receipt });
    await bench.handler.handleCallback(ctx as never, 'add', receipt);
    await bench.handler.handleCallback(ctx as never, 'add:a', receipt);
    const chosen = screen(ctx, 2).find((button) => button.callback_data.includes(':src:add:s:'));

    await bench.handler.handleCallback(ctx as never, action(chosen!.callback_data), receipt);

    expect(bench.prompts.created).toEqual([
      {
        userId: 100,
        chatId: 42,
        receiptId: receipt.id,
        promptMessageId: lastSent(ctx),
        replyMessageId: null,
        phase: 'credential',
        operation: 'attach',
        cameraId: 'camera-hallway-private-id',
        displayName: 'Hallway',
        expectedRevision: null,
        status: 'pending',
        deletionFailed: false,
        expiresAt: new Date(NOW.getTime() + CAMERA_SOURCE_PROMPT_TTL_MS),
        retainUntil: null,
      },
    ]);
  });

  it('reloads the overview instead of attaching when the chosen camera is gone', async () => {
    const bench = setup({ sources: [overviewSource()], attachCandidates: CANDIDATES });
    const ctx = context();
    await bench.handler.handleEntry(ctx as never, { receipt });
    await bench.handler.handleCallback(ctx as never, 'add', receipt);
    await bench.handler.handleCallback(ctx as never, 'add:a', receipt);

    await bench.handler.handleCallback(ctx as never, 'add:s:AAAAAAAAAAAA', receipt);

    expect(body(ctx, 3)).toContain(copy.overview.title);
    expect(bench.prompts.createPending).not.toHaveBeenCalled();
  });
});

describe('CameraSourcesHandler name replies', () => {
  it('advances the conversation on the exact reply, and persists only the proposed name', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const opened = await openNamePrompt(bench);

    const naming = context({ text: '  Side gate  ', messageId: 500, replyTo: opened.promptMessageId });
    await expect(bench.handler.handleText(naming as never)).resolves.toBe(true);

    expect(body(naming, 0)).toContain(copy.privacyNotice({
      networks: copy.policy.network(NETWORK),
      minutes: CAMERA_SOURCE_PROMPT_TTL_MS / 60_000,
    }));
    expect(body(naming, 1)).toContain(copy.prompts.credential);
    expect(markup(naming, 1)).toEqual({ force_reply: true, selective: true });
    expect(bench.prompts.created[1]).toEqual({
      userId: 100,
      chatId: 42,
      receiptId: receipt.id,
      promptMessageId: lastSent(naming),
      replyMessageId: null,
      phase: 'credential',
      operation: 'create',
      cameraId: null,
      displayName: 'Side gate',
      expectedRevision: null,
      status: 'pending',
      deletionFailed: false,
      expiresAt: new Date(NOW.getTime() + CAMERA_SOURCE_PROMPT_TTL_MS),
      retainUntil: null,
    });
    // A name is not a secret, so it is not deleted; only credentials are.
    expect(bench.messages.delete).not.toHaveBeenCalled();
  });

  /*
   * The exact-reply binding, one violated field at a time. Every one of these
   * is a plausible real update — a second administrator in the same chat, a
   * reply to the wrong message, an ordinary typed line — and none of them may
   * advance a conversation that was not addressed to it.
   */
  it('ignores a reply that names another message', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const opened = await openNamePrompt(bench);

    const naming = context({ text: 'Side gate', messageId: 500, replyTo: opened.promptMessageId + 7 });
    await expect(bench.handler.handleText(naming as never)).resolves.toBe(false);

    expect(naming.reply).not.toHaveBeenCalled();
    expect(bench.prompts.claimReply).not.toHaveBeenCalled();
    expect(bench.prompts.created).toHaveLength(1);
  });

  it('ignores another administrator replying to the same prompt', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const opened = await openNamePrompt(bench);

    const naming = context({
      text: 'Side gate',
      messageId: 500,
      replyTo: opened.promptMessageId,
      userId: 101,
    });
    await expect(bench.handler.handleText(naming as never)).resolves.toBe(false);

    expect(bench.prompts.claimReply).not.toHaveBeenCalled();
    expect(naming.reply).not.toHaveBeenCalled();
  });

  it('ignores the same reply arriving from a group chat', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const opened = await openNamePrompt(bench);

    const naming = context({
      text: 'Side gate',
      messageId: 500,
      replyTo: opened.promptMessageId,
      chatType: 'group',
      chatId: -42,
    });
    await expect(bench.handler.handleText(naming as never)).resolves.toBe(false);

    expect(bench.prompts.claimReply).not.toHaveBeenCalled();
  });

  it('ignores a message that replies to nothing', async () => {
    const bench = setup({ sources: [overviewSource()] });
    await openNamePrompt(bench);

    const naming = context({ text: 'Side gate', messageId: 500 });
    await expect(bench.handler.handleText(naming as never)).resolves.toBe(false);

    expect(bench.prompts.claimReply).not.toHaveBeenCalled();
  });

  it.each([
    ['empty', '   '],
    ['control-character', `Front${String.fromCharCode(7)}door`],
    ['overlength', 'x'.repeat(65)],
    ['address-shaped', 'rtsp://camera.local/stream'],
  ])('rejects a %s name with localized copy and a usable exact prompt', async (_label, name) => {
    const bench = setup({ sources: [overviewSource()] });
    const opened = await openNamePrompt(bench);

    const naming = context({ text: name, messageId: 500, replyTo: opened.promptMessageId });
    await expect(bench.handler.handleText(naming as never)).resolves.toBe(true);

    expect(body(naming, 0)).toBe(copy.prompts.invalidName);
    expect(body(naming, 1)).toContain(copy.prompts.name);
    expect(markup(naming, 1)).toEqual({ force_reply: true, selective: true });
    expect(sentJson(naming)).not.toContain(copy.prompts.credential);

    // The replacement prompt is a real one: replying to it advances.
    const retry = context({ text: 'Side gate', messageId: 501, replyTo: lastSent(naming) });
    await expect(bench.handler.handleText(retry as never)).resolves.toBe(true);
    expect(body(retry, 1)).toContain(copy.prompts.credential);
    expect(bench.prompts.created.at(-1)?.displayName).toBe('Side gate');
  });

  /*
   * The rejection copy is static for a reason: a name that looks like an
   * address is refused, and a refusal that quoted it would put the thing it
   * refused back into the chat — the one outcome the refusal exists to prevent.
   */
  it('never echoes a rejected name back at the administrator', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const opened = await openNamePrompt(bench);

    const naming = context({ text: SECRET_URL, messageId: 500, replyTo: opened.promptMessageId });
    await bench.handler.handleText(naming as never);

    expect(sentJson(naming)).not.toContain(SECRET_URL);
    expect(sentJson(naming)).not.toContain(SECRET_PASSWORD);
    expect(sentJson(naming)).not.toMatch(/rtsps?:\/\//iu);
    expect(JSON.stringify(bench.prompts.created)).not.toContain(SECRET_PASSWORD);
  });

  it('will not let an answered prompt be replied to twice', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const opened = await openNamePrompt(bench);
    const naming = context({ text: 'Side gate', messageId: 500, replyTo: opened.promptMessageId });
    await bench.handler.handleText(naming as never);

    const again = context({ text: 'Back door', messageId: 502, replyTo: opened.promptMessageId });
    await expect(bench.handler.handleText(again as never)).resolves.toBe(false);

    expect(again.reply).not.toHaveBeenCalled();
    expect(bench.prompts.created).toHaveLength(2);
  });

  it('refuses a name reply from an administrator who has since been demoted', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const opened = await openNamePrompt(bench);

    const naming = context({
      text: 'Side gate',
      messageId: 500,
      replyTo: opened.promptMessageId,
      role: 'user',
    });
    await bench.handler.handleText(naming as never);

    expect(naming.reply).toHaveBeenCalledWith(catalogFor('en').common.adminRequired);
    expect(bench.prompts.created).toHaveLength(1);
    expect(sentJson(naming)).not.toContain(copy.prompts.credential);
  });
});

describe('CameraSourcesHandler credential replies', () => {
  it('deletes the reply before it creates anything, then reports progress and the outcome', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const { promptMessageId } = await openCredentialPrompt(bench);

    const { ctx, claimed } = await answerAddress(bench, promptMessageId);

    expect(claimed).toBe(true);
    expect(bench.messages.delete).toHaveBeenCalledWith(42, 600);
    expect(bench.messages.delete.mock.invocationCallOrder[0])
      .toBeLessThan(bench.createRtspCamera.execute.mock.invocationCallOrder[0]);
    expect(bench.createRtspCamera.execute).toHaveBeenCalledWith({
      url: SECRET_URL,
      transport: 'tcp',
      tlsMode: 'none',
      profile: 'eco',
      substream: null,
      actorUserId: 100,
      displayName: 'Side gate',
    });
    expect(body(ctx, 0)).toBe(copy.progress.testing);
    expect(body(ctx, 1)).toBe(copy.outcomes.created('Side gate'));
    expect(sentJson(ctx)).not.toContain(copy.credentialDeletionFailed('Side gate'));
  });

  it('takes the prompt durably to running before the effect, then consumes it cleanly', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const { promptMessageId } = await openCredentialPrompt(bench);

    await answerAddress(bench, promptMessageId);

    expect(bench.prompts.claimReply).toHaveBeenCalledWith({
      userId: 100,
      chatId: 42,
      receiptId: receipt.id,
      promptMessageId,
      replyMessageId: 600,
      now: NOW,
    });
    // The claim is the CAS that makes the reply actionable, and it precedes
    // both the deletion and the Camera call.
    expect(bench.prompts.claimReply.mock.invocationCallOrder[0])
      .toBeLessThan(bench.messages.delete.mock.invocationCallOrder[0]);
    expect(bench.prompts.consume).toHaveBeenCalledWith({
      identity: { userId: 100, chatId: 42, receiptId: receipt.id, promptMessageId },
      deletionFailed: false,
      now: NOW,
    });
    await expect(bench.prompts.inner.listRunning(10)).resolves.toEqual([]);
  });

  /*
   * What a process dying mid-install would leave behind.
   *
   * The claim is durable, not a flag in memory: while the Camera boundary is
   * dialling the camera the row is `running` with the reply recorded on it,
   * which is precisely the shape startup recovery looks for — and it still
   * carries no address.
   */
  it('leaves the prompt durably running, and secret-free, while the camera work is in flight', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const { promptMessageId } = await openCredentialPrompt(bench);
    let inFlight: readonly CameraSourcePrompt[] = [];
    bench.createRtspCamera.execute.mockImplementationOnce(async () => {
      inFlight = await bench.prompts.inner.listRunning(10);
      return installedSource();
    });

    await answerAddress(bench, promptMessageId);

    expect(inFlight).toHaveLength(1);
    expect(inFlight[0]).toMatchObject({
      status: 'running',
      phase: 'credential',
      operation: 'create',
      displayName: 'Side gate',
      promptMessageId,
      replyMessageId: 600,
    });
    expect(JSON.stringify(inFlight)).not.toContain(SECRET_URL);
    expect(JSON.stringify(inFlight)).not.toContain(SECRET_PASSWORD);
    await expect(bench.prompts.inner.listRunning(10)).resolves.toEqual([]);
  });

  it('reads strict TLS off an rtsps address rather than assuming plain RTSP', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const { promptMessageId } = await openCredentialPrompt(bench);

    await answerAddress(bench, promptMessageId, { text: 'rtsps://operator:hunter2@camera.local:322/s1' });

    expect(bench.createRtspCamera.execute).toHaveBeenCalledWith(
      expect.objectContaining({ tlsMode: 'strict' }),
    );
  });

  it('attaches to the chosen camera, deleting the reply before the attach', async () => {
    const bench = setup({ sources: [overviewSource()], attachCandidates: CANDIDATES });
    const ctx = context();
    await bench.handler.handleEntry(ctx as never, { receipt });
    await bench.handler.handleCallback(ctx as never, 'add', receipt);
    await bench.handler.handleCallback(ctx as never, 'add:a', receipt);
    const chosen = screen(ctx, 2).find((button) => button.callback_data.includes(':src:add:s:'));
    await bench.handler.handleCallback(ctx as never, action(chosen!.callback_data), receipt);

    const answer = await answerAddress(bench, lastSent(ctx));

    expect(bench.messages.delete.mock.invocationCallOrder[0])
      .toBeLessThan(bench.attachRtspSource.execute.mock.invocationCallOrder[0]);
    expect(bench.attachRtspSource.execute).toHaveBeenCalledWith({
      url: SECRET_URL,
      transport: 'tcp',
      tlsMode: 'none',
      profile: 'eco',
      substream: null,
      actorUserId: 100,
      cameraId: 'camera-hallway-private-id',
    });
    expect(bench.createRtspCamera.execute).not.toHaveBeenCalled();
    expect(body(answer.ctx, 1)).toBe(copy.outcomes.attached('Hallway'));
  });

  it('never lets the address reach a reply, a durable row, a callback or a log line', async () => {
    const bench = setup({ sources: [overviewSource()] });
    // Installed before the conversation starts, so the whole exchange — not
    // just the credential reply — is under it.
    const logs = captureLogs();
    try {
      const { promptMessageId } = await openCredentialPrompt(bench);

      const { ctx } = await answerAddress(bench, promptMessageId);

      const everything = [
        JSON.stringify({
          replies: ctx.reply.mock.calls,
          persisted: bench.prompts.created,
          consumed: bench.prompts.consume.mock.calls,
          claimed: bench.prompts.claimReply.mock.calls,
          deleted: bench.messages.delete.mock.calls,
        }),
        transcript(logs.lines),
      ].join('\n');
      expect(everything).not.toContain(SECRET_URL);
      expect(everything).not.toContain(SECRET_PASSWORD);
      expect(everything).not.toContain('operator');
      expect(everything).not.toMatch(/rtsps?:\/\//iu);
      // The one call that is supposed to see it, and the only one. Without this
      // the scan above would pass just as happily on a handler that never read
      // the address at all.
      expect(bench.createRtspCamera.execute).toHaveBeenCalledWith(
        expect.objectContaining({ url: SECRET_URL }),
      );
    } finally {
      logs.restore();
    }
  });

  /*
   * Every way this can go wrong after the reply has arrived, and the one thing
   * that must be true of all of them: the deletion was already attempted.
   *
   * `role` and `readiness` refuse before the Camera boundary is reached at all,
   * so for those the assertion is that deletion happened and no use case ran;
   * the rest reach the use case, and for those the assertion is the ordering.
   */
  it('deletes the reply before refusing a demoted administrator', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const { promptMessageId } = await openCredentialPrompt(bench);

    const { ctx } = await answerAddress(bench, promptMessageId, { role: 'user' });

    expect(bench.messages.delete).toHaveBeenCalledWith(42, 600);
    expect(bench.createRtspCamera.execute).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(catalogFor('en').common.adminRequired);
    expect(sentJson(ctx)).not.toContain(copy.progress.testing);
    expect(bench.prompts.consume).toHaveBeenCalledWith(
      expect.objectContaining({ deletionFailed: false }),
    );
  });

  it('deletes the reply before refusing a feature that went unready under it', async () => {
    const availability: FeatureAvailabilityPort = {
      awaitInitialVerification: vi.fn(),
      inspect: vi.fn(),
      requireReady: vi.fn().mockResolvedValue(undefined),
    };
    const bench = setup({ sources: [overviewSource()], availability });
    const { promptMessageId } = await openCredentialPrompt(bench);
    availability.requireReady = vi.fn().mockRejectedValue(new FeatureUnavailableError('rtsp', 'needs-attention'));

    const { ctx } = await answerAddress(bench, promptMessageId);

    expect(bench.messages.delete).toHaveBeenCalledWith(42, 600);
    expect(bench.createRtspCamera.execute).not.toHaveBeenCalled();
    const feature = catalogFor('en').feature;
    expect(ctx.reply).toHaveBeenCalledWith(feature.stale.attention(feature.names.rtsp));
  });

  it.each([
    ['an unusable address', new InvalidLiveSourceError('URL scheme must be rtsp or rtsps'), 'invalid-address'],
    ['an address outside the policy', new RtspPolicyDigestMismatchError('digest'), 'policy-stale'],
    ['a camera that never answered', new LiveSourceProbeTimeoutError(), 'timed-out'],
  ] as const)('deletes the reply before %s is reported', async (_label, error, kind) => {
    const bench = setup({ sources: [overviewSource()] });
    bench.createRtspCamera.execute.mockRejectedValueOnce(error);
    const { promptMessageId } = await openCredentialPrompt(bench);

    const { ctx } = await answerAddress(bench, promptMessageId);

    expect(bench.messages.delete.mock.invocationCallOrder[0])
      .toBeLessThan(bench.createRtspCamera.execute.mock.invocationCallOrder[0]);
    expect(ctx.reply).toHaveBeenCalledWith(copy.errors[kind]);
    expect(sentJson(ctx)).not.toContain(SECRET_URL);
    expect(sentJson(ctx)).not.toContain(SECRET_PASSWORD);
    // The failure is terminal for the prompt whichever way it went.
    expect(bench.prompts.consume).toHaveBeenCalledTimes(1);
  });

  it('retries a refused deletion once, and says nothing when the retry succeeds', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const { promptMessageId } = await openCredentialPrompt(bench);
    bench.messages.delete
      .mockRejectedValueOnce(new CameraSourceMessageDeletionError())
      .mockResolvedValueOnce(undefined);

    const { ctx } = await answerAddress(bench, promptMessageId);

    expect(bench.messages.delete).toHaveBeenCalledTimes(2);
    // The retry runs after the Camera work, in the `finally` — not instead of it.
    expect(bench.messages.delete.mock.invocationCallOrder[1])
      .toBeGreaterThan(bench.createRtspCamera.execute.mock.invocationCallOrder[0]);
    expect(sentJson(ctx)).not.toContain(copy.credentialDeletionFailed('Side gate'));
    expect(bench.prompts.consume).toHaveBeenCalledWith(
      expect.objectContaining({ deletionFailed: false }),
    );
  });

  it('asks the administrator to delete the reply themselves when both attempts fail', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const { promptMessageId } = await openCredentialPrompt(bench);
    bench.messages.delete.mockRejectedValue(new CameraSourceMessageDeletionError());

    const { ctx } = await answerAddress(bench, promptMessageId);

    expect(bench.messages.delete).toHaveBeenCalledTimes(2);
    expect(ctx.reply).toHaveBeenCalledWith(copy.credentialDeletionFailed('Side gate'));
    // It names the camera the reply belongs to, and nothing about the address.
    expect(copy.credentialDeletionFailed('Side gate')).toContain('Side gate');
    expect(sentJson(ctx)).not.toContain(SECRET_URL);
    expect(bench.prompts.consume).toHaveBeenCalledWith(
      expect.objectContaining({ deletionFailed: true }),
    );
    // The camera was still created: a deletion Telegram refused is not a reason
    // to throw away work the administrator asked for.
    expect(bench.createRtspCamera.execute).toHaveBeenCalledTimes(1);
  });

  it('does not retry a deletion that already succeeded', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const { promptMessageId } = await openCredentialPrompt(bench);

    await answerAddress(bench, promptMessageId);

    expect(bench.messages.delete).toHaveBeenCalledTimes(1);
  });

  it('deletes but does not act on a reply that arrives after the window closed', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const { promptMessageId } = await openCredentialPrompt(bench);
    bench.advance(CAMERA_SOURCE_PROMPT_TTL_MS);
    // A refused first attempt is retried here too: cleanup owes the same
    // deletion the winning path does.
    bench.messages.delete
      .mockRejectedValueOnce(new CameraSourceMessageDeletionError())
      .mockResolvedValueOnce(undefined);

    const { claimed } = await answerAddress(bench, promptMessageId);

    expect(claimed).toBe(true);
    expect(bench.messages.delete).toHaveBeenCalledTimes(2);
    expect(bench.messages.delete).toHaveBeenLastCalledWith(42, 600);
    expect(bench.createRtspCamera.execute).not.toHaveBeenCalled();
    expect(bench.attachRtspSource.execute).not.toHaveBeenCalled();
  });
});

describe('CameraSourcesHandler claims nothing it was not asked for', () => {
  it.each([
    ['an address typed out of the blue', { text: SECRET_URL }],
    ['a localized cancel word with no prompt open', { text: copy.cancelSynonyms[0] }],
    ['a reply to some unrelated message', { text: SECRET_URL, replyTo: 4242 }],
  ])('ignores %s', async (_label, message) => {
    const bench = setup({ sources: [overviewSource()] });
    const ctx = context({ ...message, messageId: 700 });

    await expect(bench.handler.handleText(ctx as never)).resolves.toBe(false);

    expect(bench.prompts.claimReply).not.toHaveBeenCalled();
    expect(bench.messages.delete).not.toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it('ignores a late reply to a message that is not this prompt, while a prompt is open', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const { promptMessageId } = await openCredentialPrompt(bench);

    const stray = context({ text: SECRET_URL, messageId: 700, replyTo: promptMessageId - 1 });
    await expect(bench.handler.handleText(stray as never)).resolves.toBe(false);

    expect(bench.prompts.claimReply).not.toHaveBeenCalled();
    expect(bench.messages.delete).not.toHaveBeenCalled();
  });

  it('ignores an address replied to the prompt from a group chat', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const { promptMessageId } = await openCredentialPrompt(bench);

    const group = context({
      text: SECRET_URL,
      messageId: 700,
      replyTo: promptMessageId,
      chatType: 'supergroup',
      chatId: -1001,
    });
    await expect(bench.handler.handleText(group as never)).resolves.toBe(false);

    expect(bench.prompts.claimReply).not.toHaveBeenCalled();
    expect(bench.createRtspCamera.execute).not.toHaveBeenCalled();
  });

  it('ignores an address replied to the prompt by another user', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const { promptMessageId } = await openCredentialPrompt(bench);

    const other = context({ text: SECRET_URL, messageId: 700, replyTo: promptMessageId, userId: 101 });
    await expect(bench.handler.handleText(other as never)).resolves.toBe(false);

    expect(bench.prompts.claimReply).not.toHaveBeenCalled();
    expect(bench.createRtspCamera.execute).not.toHaveBeenCalled();
  });
});

/*
 * The same conversation, against the storage that actually ships.
 *
 * The in-memory twin above proves the handler never *hands* a secret to the
 * repository; this proves nothing lands in SQLite by another route — a column
 * written behind the port, a value that survived encoding, a file the adapter
 * touched. It is the assertion the design promise is written in.
 */
describe('CameraSourcesHandler credential replies against SQLite', () => {
  it('leaves no address, user or password anywhere in the prompt table', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'camera-source-handler-'));
    const file = join(directory, 'prompts.db');
    const sqlite = new Database(file);
    try {
      sqlite.pragma('foreign_keys = ON');
      const db = drizzle(sqlite, { schema });
      migrate(db, { migrationsFolder: './migrations' });
      sqlite.prepare('INSERT INTO users (telegram_id, name, role) VALUES (?, ?, ?)')
        .run(100, 'admin', 'admin');
      const bench = setup({
        sources: [overviewSource()],
        prompts: promptStore(new DrizzleCameraSourcePromptRepository(db)),
      });

      const { promptMessageId } = await openCredentialPrompt(bench);
      await answerAddress(bench, promptMessageId);

      expect(bench.createRtspCamera.execute).toHaveBeenCalledWith(
        expect.objectContaining({ url: SECRET_URL }),
      );
      const rows = JSON.stringify(
        sqlite.prepare('SELECT * FROM telegram_camera_source_prompts').all(),
      );
      expect(rows).not.toContain(SECRET_URL);
      expect(rows).not.toContain(SECRET_PASSWORD);
      expect(rows).not.toContain('operator');
      expect(rows).not.toContain('camera.local');
      expect(rows).not.toMatch(/rtsps?:\/\//iu);
      // The tombstone that is there carries the non-secret selection and the
      // one bit a refused deletion is allowed to leave behind.
      expect(rows).toContain('Side gate');
      expect(rows).toContain('"status":"consumed"');
      expect(rows).toContain('"deletion_failed":0');
    } finally {
      sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('records the refused deletion, and still no address, when Telegram will not delete', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'camera-source-handler-'));
    const sqlite = new Database(join(directory, 'prompts.db'));
    try {
      sqlite.pragma('foreign_keys = ON');
      const db = drizzle(sqlite, { schema });
      migrate(db, { migrationsFolder: './migrations' });
      sqlite.prepare('INSERT INTO users (telegram_id, name, role) VALUES (?, ?, ?)')
        .run(100, 'admin', 'admin');
      const bench = setup({
        sources: [overviewSource()],
        prompts: promptStore(new DrizzleCameraSourcePromptRepository(db)),
      });
      const { promptMessageId } = await openCredentialPrompt(bench);
      bench.messages.delete.mockRejectedValue(new CameraSourceMessageDeletionError());

      await answerAddress(bench, promptMessageId);

      const rows = JSON.stringify(
        sqlite.prepare('SELECT * FROM telegram_camera_source_prompts').all(),
      );
      expect(rows).toContain('"deletion_failed":1');
      expect(rows).not.toContain(SECRET_URL);
      expect(rows).not.toContain(SECRET_PASSWORD);
      // The claimed reply's identity is kept — that is what a later retry needs
      // — and it is a message number, not its contents.
      expect(rows).toContain('"reply_message_id":600');
    } finally {
      sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

/*
 * Two escape routes the ordering tests above cannot see.
 *
 * The address is a local in one frame; the ways it could stop being one are
 * that it is written somewhere that outlives the call, or that a guard which
 * looks redundant is removed because a *different* guard happened to be
 * catching the same case.
 */
describe('CameraSourcesHandler keeps the address on the stack', () => {
  /*
   * The retention scan is only as good as its reach, and its reach is not
   * self-evident: the assertion it powers is a negative one, so a walk that
   * quietly stopped at the first `Map` would report "no secret found" in
   * exactly the same words as a walk that searched everything. These pin the
   * two containers `JSON.stringify` renders as `{}`.
   */
  it('reaches strings held in a Map or a Set, which JSON.stringify cannot', () => {
    expect(reachableStrings(new Map([['key', 'held-in-a-map']]))).toContain('held-in-a-map');
    expect(reachableStrings(new Set(['held-in-a-set']))).toContain('held-in-a-set');
    expect(reachableStrings({ nested: [{ deep: new Map([[1, 'held-deeper']]) }] })).toContain('held-deeper');
    expect(JSON.stringify(new Map([['key', 'held-in-a-map']]))).toBe('{}');
  });

  it('leaves nothing behind on the handler once the reply is answered', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const { promptMessageId } = await openCredentialPrompt(bench);

    await answerAddress(bench, promptMessageId);

    // Everything this handler still holds — its own fields, the view state it
    // keeps in a Map, and every value it handed the repository.
    const retained = reachableStrings(bench.handler).join('\n');
    expect(retained).not.toContain(SECRET_URL);
    expect(retained).not.toContain(SECRET_PASSWORD);
    expect(retained).not.toContain('camera.local');
    expect(JSON.stringify(bench.prompts.created)).not.toContain(SECRET_PASSWORD);
    // The scan reaches the view state at all: without this a walk that stopped
    // short — at a Map it could not expand, or a depth it never got past —
    // would assert nothing and say so in exactly the same words.
    expect(retained).toContain('Side gate');
  });

  /*
   * The success path clears the screen, which would quietly dispose of a
   * stashed address along with it. A failure keeps the screen alive on purpose
   * — Task 6's recovery actions need it — so this is the path where a value
   * written into the view state genuinely outlives the call, and the one worth
   * scanning.
   */
  it('leaves nothing behind when the install fails and the screen is kept alive', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const { promptMessageId } = await openCredentialPrompt(bench);
    bench.createRtspCamera.execute.mockRejectedValueOnce(new LiveSourceProbeTimeoutError());

    await answerAddress(bench, promptMessageId);

    expect(bench.handler.hasPending(100, 42, receipt.id)).toBe(true);
    const retained = reachableStrings(bench.handler).join('\n');
    expect(retained).not.toContain(SECRET_URL);
    expect(retained).not.toContain(SECRET_PASSWORD);
    expect(retained).not.toContain('camera.local');
    // The walk reaches the state that was deliberately kept: without this the
    // assertions above would hold just as well over an empty store.
    expect(retained).toContain(receipt.id);
  });

  /*
   * A group message is refused for two independent reasons — the chat is not
   * private, and a group's identifier is negative, which the prompt model will
   * not accept. Real groups always supply both, so a test that used a real
   * group identifier would keep passing with the privacy check deleted. This
   * one supplies a positive identifier on purpose, so the privacy check is the
   * only thing standing in the way and is measured on its own.
   */
  it('refuses a non-private chat even when its identifier would pass every other guard', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const { promptMessageId } = await openCredentialPrompt(bench);

    const group = context({
      text: SECRET_URL,
      messageId: 700,
      replyTo: promptMessageId,
      chatType: 'group',
      chatId: 42,
    });
    await expect(bench.handler.handleText(group as never)).resolves.toBe(false);

    expect(bench.prompts.claimReply).not.toHaveBeenCalled();
    expect(bench.messages.delete).not.toHaveBeenCalled();
    expect(bench.createRtspCamera.execute).not.toHaveBeenCalled();
  });
});

/*
 * The row is gone but the message is not.
 *
 * A prompt whose durable row has vanished — pruned, or lost with the database
 * — can authorise nothing: there is no claim to win and no camera selection to
 * trust. The reply is still a real message sitting in a real chat, so a
 * credential one is deleted anyway, and a name one is simply not ours.
 */
describe('CameraSourcesHandler replies whose durable prompt is gone', () => {
  it('still deletes a credential reply, and calls no Camera use case', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const { promptMessageId } = await openCredentialPrompt(bench);
    bench.prompts.claimReply.mockResolvedValueOnce({ kind: 'stale' });

    const { ctx, claimed } = await answerAddress(bench, promptMessageId);

    expect(claimed).toBe(true);
    expect(bench.messages.delete).toHaveBeenCalledWith(42, 600);
    expect(bench.createRtspCamera.execute).not.toHaveBeenCalled();
    expect(bench.attachRtspSource.execute).not.toHaveBeenCalled();
    expect(sentJson(ctx)).not.toContain(SECRET_URL);
  });

  it('hands a name reply back to the next handler and deletes nothing', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const opened = await openNamePrompt(bench);
    bench.prompts.claimReply.mockResolvedValueOnce({ kind: 'stale' });

    const naming = context({ text: 'Side gate', messageId: 500, replyTo: opened.promptMessageId });
    await expect(bench.handler.handleText(naming as never)).resolves.toBe(false);

    expect(bench.messages.delete).not.toHaveBeenCalled();
    expect(naming.reply).not.toHaveBeenCalled();
  });
});

/*
 * What survives an answer, and what does not.
 *
 * Task 6 attaches Retry / Change address / Reinstall RTSP to failure messages,
 * and both halves of this contract are load-bearing for that: a completed
 * receipt makes those buttons inert at `validateCurrent`, and a cleared view
 * state loses the page the administrator was on.
 */
describe('CameraSourcesHandler navigation state across outcomes', () => {
  it('keeps the receipt and the remembered page alive through a failure', async () => {
    const bench = setup({ sources: manySources(20) });
    const opener = context();
    await bench.handler.handleEntry(opener as never, { receipt });
    await bench.handler.handleCallback(opener as never, 'p:2', receipt);
    await bench.handler.handleCallback(opener as never, 'add', receipt);
    const { promptMessageId } = await openCredentialPromptOn(bench, opener);
    bench.createRtspCamera.execute.mockRejectedValueOnce(new LiveSourceProbeTimeoutError());

    const { ctx } = await answerAddress(bench, promptMessageId);

    expect(ctx.reply).toHaveBeenCalledWith(copy.errors['timed-out']);
    // The workflow is not over: Task 6's recovery callbacks are gated on
    // `validateCurrent`, which only accepts a receipt that is still current.
    expect(bench.navigation.complete).not.toHaveBeenCalled();
    expect(bench.handler.hasPending(100, 42, receipt.id)).toBe(true);
    // And the administrator is still on the page they started from.
    await bench.handler.handleCallback(opener as never, 'over', receipt);
    expect(bench.overview.execute).toHaveBeenLastCalledWith({ page: 2, pageSize: 8 });
  });

  it('keeps them alive through a refusal too', async () => {
    const bench = setup({ sources: manySources(20) });
    const opener = context();
    await bench.handler.handleEntry(opener as never, { receipt });
    await bench.handler.handleCallback(opener as never, 'p:2', receipt);
    await bench.handler.handleCallback(opener as never, 'add', receipt);
    const { promptMessageId } = await openCredentialPromptOn(bench, opener);

    const { ctx } = await answerAddress(bench, promptMessageId, { role: 'user' });

    expect(ctx.reply).toHaveBeenCalledWith(catalogFor('en').common.adminRequired);
    expect(bench.navigation.complete).not.toHaveBeenCalled();
    expect(bench.handler.hasPending(100, 42, receipt.id)).toBe(true);
  });

  it('ends the workflow and forgets the screen only on a successful install', async () => {
    const bench = setup({ sources: manySources(20) });
    const opener = context();
    await bench.handler.handleEntry(opener as never, { receipt });
    await bench.handler.handleCallback(opener as never, 'p:2', receipt);
    await bench.handler.handleCallback(opener as never, 'add', receipt);
    const { promptMessageId } = await openCredentialPromptOn(bench, opener);

    const { ctx } = await answerAddress(bench, promptMessageId);

    expect(ctx.reply).toHaveBeenCalledWith(copy.outcomes.created('Side gate'));
    expect(bench.navigation.complete).toHaveBeenCalledTimes(1);
    expect(bench.handler.hasPending(100, 42, receipt.id)).toBe(false);
  });
});

/*
 * Uniqueness is the Camera boundary's to decide — it holds the transaction —
 * but discovering a collision there costs the administrator a pasted
 * credential, because `name-taken` offers only `back`. So it is *advised* at
 * name time, when nothing has been pasted yet, and still *decided* at the
 * boundary.
 */
describe('CameraSourcesHandler display-name uniqueness', () => {
  it('advises against a name a camera already answers to, before any address is asked for', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const opened = await openNamePrompt(bench);

    // Same camera, different case and spacing: `cameraNameKey` is what decides.
    const naming = context({ text: '  fRoNt DOOR ', messageId: 500, replyTo: opened.promptMessageId });
    await expect(bench.handler.handleText(naming as never)).resolves.toBe(true);

    expect(body(naming, 0)).toBe(copy.errors['name-taken']);
    expect(sentJson(naming)).not.toContain(copy.prompts.credential);
    expect(sentJson(naming)).not.toContain(copy.privacyNotice({
      networks: copy.policy.network(NETWORK),
      minutes: CAMERA_SOURCE_PROMPT_TTL_MS / 60_000,
    }));
    // Re-prompted, not dead-ended: the replacement prompt is a working one.
    expect(markup(naming, 1)).toEqual({ force_reply: true, selective: true });
    const retry = context({ text: NEW_CAMERA, messageId: 501, replyTo: lastSent(naming) });
    await expect(bench.handler.handleText(retry as never)).resolves.toBe(true);
    expect(body(retry, 1)).toContain(copy.prompts.credential);
    expect(bench.prompts.created.at(-1)?.displayName).toBe(NEW_CAMERA);
  });

  it('still reports a collision the boundary catches, after deleting the address', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const { promptMessageId } = await openCredentialPrompt(bench);
    // The advisory check passed and the camera was created underneath anyway.
    bench.createRtspCamera.execute.mockRejectedValueOnce(new CameraNameTakenError());

    const { ctx } = await answerAddress(bench, promptMessageId);

    expect(bench.messages.delete.mock.invocationCallOrder[0])
      .toBeLessThan(bench.createRtspCamera.execute.mock.invocationCallOrder[0]);
    expect(ctx.reply).toHaveBeenCalledWith(copy.errors['name-taken']);
    expect(sentJson(ctx)).not.toContain(SECRET_URL);
  });

  it('advises nothing, and blocks nothing, when the camera list cannot be read', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const opened = await openNamePrompt(bench);
    bench.cameras.execute.mockRejectedValueOnce(new Error('camera table is locked'));

    const naming = context({ text: 'Front door', messageId: 500, replyTo: opened.promptMessageId });
    await bench.handler.handleText(naming as never);

    // An advisory check that blocked when it could not answer would make an
    // unreadable camera list a reason nobody can add a camera at all.
    expect(body(naming, 1)).toContain(copy.prompts.credential);
    expect(sentJson(naming)).not.toContain(copy.errors['name-taken']);
    expect(sentJson(naming)).not.toContain('camera table is locked');
  });
});

/*
 * The candidate list is every enabled non-RTSP camera without a source. The
 * Camera boundary filters it but does not bound it, so this screen must.
 */
describe('CameraSourcesHandler attach candidate paging', () => {
  function candidates(count: number) {
    return Array.from({ length: count }, (_, index) => ({
      cameraId: `camera-candidate-id-${index}`,
      cameraName: `Candidate ${index}`,
    }));
  }

  async function openCandidates(bench: Bench) {
    const ctx = context();
    await bench.handler.handleEntry(ctx as never, { receipt });
    await bench.handler.handleCallback(ctx as never, 'add', receipt);
    await bench.handler.handleCallback(ctx as never, 'add:a', receipt);
    return ctx;
  }

  it('shows eight cameras per page with a way forward, never the whole install', async () => {
    const bench = setup({ sources: [overviewSource()], attachCandidates: candidates(30) });

    const ctx = await openCandidates(bench);

    const rendered = screen(ctx, 2);
    expect(rendered.filter((button) => button.callback_data.includes(':src:add:s:'))).toHaveLength(8);
    expect(rendered.map((button) => button.text)).toContain(copy.overview.next);
    expect(rendered.map((button) => button.text)).not.toContain(copy.overview.previous);
    expect(rendered.map((button) => button.callback_data)).toContain('cam:abcdefghijklmnop:src:add:a:2');
    expect(body(ctx, 2)).toContain(copy.add.chooseCamera);
    expect(body(ctx, 2)).toContain(copy.overview.page(1, 4));
    expect(sentJson(ctx)).not.toContain('camera-candidate-id-');
    for (const button of rendered) {
      expect(Buffer.byteLength(button.callback_data, 'utf8'), button.callback_data).toBeLessThanOrEqual(64);
    }
  });

  it('pages forward and back over the same window, and attaches from a later page', async () => {
    const bench = setup({ sources: [overviewSource()], attachCandidates: candidates(30) });
    const ctx = await openCandidates(bench);

    await bench.handler.handleCallback(ctx as never, 'add:a:4', receipt);

    const last = screen(ctx, 3);
    expect(last.filter((button) => button.callback_data.includes(':src:add:s:'))).toHaveLength(6);
    expect(last.map((button) => button.text)).toContain(copy.overview.previous);
    expect(last.map((button) => button.text)).not.toContain(copy.overview.next);
    expect(body(ctx, 3)).toContain(copy.overview.page(4, 4));

    // A row on the last page resolves to the camera it names, not to page one's.
    const chosen = last.find((button) => button.callback_data.includes(':src:add:s:'));
    await bench.handler.handleCallback(ctx as never, action(chosen!.callback_data), receipt);
    expect(bench.prompts.created.at(-1)).toMatchObject({
      phase: 'credential',
      operation: 'attach',
      cameraId: 'camera-candidate-id-24',
      displayName: 'Candidate 24',
    });
  });

  it('omits the page line and the pager for a list that fits', async () => {
    const bench = setup({ sources: [overviewSource()], attachCandidates: candidates(8) });

    const ctx = await openCandidates(bench);

    expect(body(ctx, 2)).not.toContain(copy.overview.page(1, 1));
    expect(screen(ctx, 2).map((button) => button.text)).not.toContain(copy.overview.next);
  });

  it('clamps a page beyond the end rather than rendering an empty chooser', async () => {
    const bench = setup({ sources: [overviewSource()], attachCandidates: candidates(10) });
    const ctx = await openCandidates(bench);

    await bench.handler.handleCallback(ctx as never, 'add:a:99', receipt);

    expect(screen(ctx, 3).filter((button) => button.callback_data.includes(':src:add:s:'))).toHaveLength(2);
    expect(body(ctx, 3)).toContain(copy.overview.page(2, 2));
  });

  it('answers rather than throwing when Telegram refuses the chooser', async () => {
    const bench = setup({ sources: [overviewSource()], attachCandidates: candidates(8) });
    const ctx = context();
    await bench.handler.handleEntry(ctx as never, { receipt });
    await bench.handler.handleCallback(ctx as never, 'add', receipt);
    ctx.reply.mockRejectedValueOnce(new Error('Bad Request: message reply markup is too long'));

    await expect(bench.handler.handleCallback(ctx as never, 'add:a', receipt)).resolves.toBeUndefined();

    expect(ctx.reply).toHaveBeenLastCalledWith(copy.errors['probe-failed']);
    expect(sentJson(ctx)).not.toContain('reply markup is too long');
  });
});

/*
 * ─── Stored-source lifecycle ───────────────────────────────────────────────
 *
 * Test, replace and remove all act on a source that already exists, so all
 * three share one obligation the add conversations do not have: the row they
 * act on must be the row the administrator was looking at. That is what the
 * revision fencing below is, and it is why every one of these paths re-reads
 * the page before it does anything.
 */

/** Opens Sources, then the one source's detail, and reports its selector. */
async function openSourceDetail(bench: Bench, ctx = context()) {
  await bench.handler.handleEntry(ctx as never, { receipt });
  const opener = screen(ctx, 0).find((button) => button.callback_data.includes(':src:d:'));
  if (!opener) throw new Error('the overview rendered no source row');
  const opened = action(opener.callback_data);
  await bench.handler.handleCallback(ctx as never, opened, receipt);
  return { ctx, selector: opened.slice(2), opened };
}

/** The confirm control on a rendered removal confirmation. */
function removalConfirm(ctx: ReturnType<typeof context>, index: number): string {
  const control = screen(ctx, index).find((button) => button.callback_data.includes(':src:rm:y:'));
  if (!control) throw new Error('the confirmation rendered no removal control');
  return action(control.callback_data);
}

describe('CameraSourcesHandler test connection', () => {
  it('reports progress, asks only who and which camera, and renders the transient result', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const { ctx } = await openSourceDetail(bench);

    await bench.handler.handleCallback(ctx as never, 'test', receipt);

    expect(bench.testRtspSource.execute).toHaveBeenCalledWith({
      actorUserId: 100,
      cameraId: 'camera-with-private-id',
    });
    expect(body(ctx, 2)).toBe(copy.progress.testing);
    expect(body(ctx, 3)).toBe(copy.outcomes.tested('Front door'));
  });

  /*
   * The one claim `outcomes.tested` makes — "Nothing was changed" — reduced to
   * what this layer can actually prove: no mutation use case is reachable from
   * here, and the projection the screen was handed comes back byte for byte,
   * revision, `verifiedAt`, digest and credential flag included.
   */
  it('changes nothing: no mutation runs and the stored projection is untouched', async () => {
    const source = overviewSource();
    const before = structuredClone(source);
    const bench = setup({ sources: [source] });
    const { ctx } = await openSourceDetail(bench);

    await bench.handler.handleCallback(ctx as never, 'test', receipt);

    expect(source).toEqual(before);
    expect(bench.replaceRtspSource.execute).not.toHaveBeenCalled();
    expect(bench.removeRtspSource.execute).not.toHaveBeenCalled();
    expect(bench.createRtspCamera.execute).not.toHaveBeenCalled();
    expect(bench.attachRtspSource.execute).not.toHaveBeenCalled();
    expect(bench.prompts.createPending).not.toHaveBeenCalled();
  });

  it('leaves the screen and the workflow exactly where they were', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const { ctx } = await openSourceDetail(bench);

    await bench.handler.handleCallback(ctx as never, 'test', receipt);

    expect(bench.navigation.complete).not.toHaveBeenCalled();
    expect(bench.handler.hasPending(100, 42, receipt.id)).toBe(true);
  });

  it('reloads the overview rather than testing what it merely remembers', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const ctx = context();
    await bench.handler.handleEntry(ctx as never, { receipt });

    await bench.handler.handleCallback(ctx as never, 'test', receipt);

    expect(bench.testRtspSource.execute).not.toHaveBeenCalled();
    expect(body(ctx, 1)).toContain(copy.overview.title);
  });
});

describe('CameraSourcesHandler change address', () => {
  it('captures the current revision onto a durable replace prompt, behind the same privacy notice', async () => {
    const bench = setup({ sources: [overviewSource({ revision: 4 })] });
    const { ctx } = await openSourceDetail(bench);

    await bench.handler.handleCallback(ctx as never, 'addr', receipt);

    expect(body(ctx, 2)).toBe(copy.privacyNotice({ networks: copy.policy.network(NETWORK), minutes: 10 }));
    expect(body(ctx, 3)).toContain(copy.prompts.credential);
    expect(bench.prompts.created).toHaveLength(1);
    expect(bench.prompts.created[0]).toMatchObject({
      phase: 'credential',
      operation: 'replace',
      cameraId: 'camera-with-private-id',
      displayName: 'Front door',
      expectedRevision: 4,
      status: 'pending',
    });
  });

  /*
   * The fence, and the only test that can see it fail: the source moves to
   * revision 9 while the administrator is typing, and the replacement still
   * carries the 4 they were shown. A handler that re-read the revision at
   * install time would send 9 and overwrite work it never displayed.
   */
  it('deletes the reply before probing and replaces at the revision it captured, not the current one', async () => {
    const source = overviewSource({ revision: 4 });
    const bench = setup({ sources: [source] });
    const { ctx } = await openSourceDetail(bench);
    await bench.handler.handleCallback(ctx as never, 'addr', receipt);
    source.revision = 9;

    const answer = await answerAddress(bench, lastSent(ctx));

    expect(bench.messages.delete.mock.invocationCallOrder[0])
      .toBeLessThan(bench.replaceRtspSource.execute.mock.invocationCallOrder[0]);
    expect(bench.replaceRtspSource.execute).toHaveBeenCalledWith({
      url: SECRET_URL,
      transport: 'tcp',
      tlsMode: 'none',
      profile: 'eco',
      substream: null,
      actorUserId: 100,
      cameraId: 'camera-with-private-id',
      expectedRevision: 4,
    });
    expect(bench.createRtspCamera.execute).not.toHaveBeenCalled();
    expect(bench.attachRtspSource.execute).not.toHaveBeenCalled();
    expect(body(answer.ctx, 1)).toBe(copy.outcomes.replaced('Front door'));
  });

  it('ends the workflow on a replacement that answered, as any other install does', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const { ctx } = await openSourceDetail(bench);
    await bench.handler.handleCallback(ctx as never, 'addr', receipt);

    await answerAddress(bench, lastSent(ctx));

    expect(bench.navigation.complete).toHaveBeenCalledTimes(1);
    expect(bench.handler.hasPending(100, 42, receipt.id)).toBe(false);
  });

  it('never writes the replacement address to the prompt row', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const { ctx } = await openSourceDetail(bench);
    await bench.handler.handleCallback(ctx as never, 'addr', receipt);

    await answerAddress(bench, lastSent(ctx));

    const persisted = JSON.stringify(bench.prompts.created);
    expect(persisted).not.toContain(SECRET_URL);
    expect(persisted).not.toContain(SECRET_PASSWORD);
    expect(reachableStrings(bench.handler).join('\n')).not.toContain(SECRET_PASSWORD);
  });

  it('reloads the overview rather than replacing what it merely remembers', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const ctx = context();
    await bench.handler.handleEntry(ctx as never, { receipt });

    await bench.handler.handleCallback(ctx as never, 'addr', receipt);

    expect(bench.prompts.createPending).not.toHaveBeenCalled();
    expect(body(ctx, 1)).toContain(copy.overview.title);
  });
});

describe('CameraSourcesHandler removal', () => {
  it('confirms by name, in the camera wording, for a camera that exists only to carry the source', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const { ctx } = await openSourceDetail(bench);

    await bench.handler.handleCallback(ctx as never, 'rm', receipt);

    expect(body(ctx, 2)).toBe(copy.removal.confirmCamera('Front door'));
    const texts = screen(ctx, 2).map((button) => button.text);
    expect(texts).toContain(copy.removal.removeCameraButton);
    expect(texts).toContain(copy.removal.keep);
    expect(texts).not.toContain(copy.removal.removeSourceButton);
    expect(bench.removeRtspSource.execute).not.toHaveBeenCalled();
  });

  it('confirms in the source wording when the camera records on its own too', async () => {
    const bench = setup({
      sources: [overviewSource()],
      cameras: [{ id: 'camera-with-private-id', name: 'Front door', type: 'motion', enabled: true, config: null }],
    });
    const { ctx } = await openSourceDetail(bench);

    await bench.handler.handleCallback(ctx as never, 'rm', receipt);

    expect(body(ctx, 2)).toBe(copy.removal.confirmSource('Front door'));
    const texts = screen(ctx, 2).map((button) => button.text);
    expect(texts).toContain(copy.removal.removeSourceButton);
    expect(texts).not.toContain(copy.removal.removeCameraButton);
  });

  /*
   * The removal's own fence. The confirmation control carries the revision the
   * confirmation was rendered from, so a source that moved between reading and
   * confirming loses the compare-and-swap instead of being deleted from under
   * whoever moved it.
   */
  it('carries the rendered revision on the confirm control and retires at exactly that revision', async () => {
    const source = overviewSource({ revision: 4 });
    const bench = setup({ sources: [source] });
    const { ctx, selector } = await openSourceDetail(bench);
    await bench.handler.handleCallback(ctx as never, 'rm', receipt);
    const confirm = removalConfirm(ctx, 2);
    expect(confirm).toBe(`rm:y:${selector}:4`);
    source.revision = 9;

    await bench.handler.handleCallback(ctx as never, confirm, receipt);

    expect(bench.removeRtspSource.execute).toHaveBeenCalledWith({
      actorUserId: 100,
      cameraId: 'camera-with-private-id',
      expectedRevision: 4,
    });
    expect(body(ctx, 3)).toBe(copy.progress.removing);
  });

  /*
   * The label is a prediction from the camera type; `{ removed }` is what the
   * transaction actually did. They are derived from the same fact and normally
   * agree — so the outcome is read off the boundary, never off the prediction.
   */
  it('names the outcome from the boundary even when the predicted label disagrees', async () => {
    const bench = setup({ sources: [overviewSource()], removed: 'source' });
    const { ctx } = await openSourceDetail(bench);
    await bench.handler.handleCallback(ctx as never, 'rm', receipt);
    expect(body(ctx, 2)).toBe(copy.removal.confirmCamera('Front door'));

    await bench.handler.handleCallback(ctx as never, removalConfirm(ctx, 2), receipt);

    expect(body(ctx, 4)).toBe(copy.removal.removedSource('Front door'));
    expect(bodies(ctx)).not.toContain(copy.removal.removedCamera('Front door'));
  });

  it('reports a retired camera as a retired camera', async () => {
    const bench = setup({ sources: [overviewSource()], removed: 'camera' });
    const { ctx } = await openSourceDetail(bench);
    await bench.handler.handleCallback(ctx as never, 'rm', receipt);

    await bench.handler.handleCallback(ctx as never, removalConfirm(ctx, 2), receipt);

    expect(body(ctx, 4)).toBe(copy.removal.removedCamera('Front door'));
    expect(bench.navigation.complete).toHaveBeenCalledTimes(1);
  });

  /*
   * Removal needs the revision and the identifier and nothing else. An exact
   * argument match is what says so: a handler that had loaded a credential to
   * remove one would have had to put it somewhere, and there is nowhere here.
   */
  it('retires without asking for a credential, an address, or a name', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const { ctx } = await openSourceDetail(bench);
    await bench.handler.handleCallback(ctx as never, 'rm', receipt);

    await bench.handler.handleCallback(ctx as never, removalConfirm(ctx, 2), receipt);

    expect(Object.keys(bench.removeRtspSource.execute.mock.calls[0][0]).sort())
      .toEqual(['actorUserId', 'cameraId', 'expectedRevision']);
    expect(bench.prompts.createPending).not.toHaveBeenCalled();
    expect(bench.messages.delete).not.toHaveBeenCalled();
  });

  it('keeps the source when Keep is pressed, and returns to its detail', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const { ctx, selector } = await openSourceDetail(bench);
    await bench.handler.handleCallback(ctx as never, 'rm', receipt);
    const keep = screen(ctx, 2).find((button) => button.text === copy.removal.keep);

    await bench.handler.handleCallback(ctx as never, action(keep!.callback_data), receipt);

    expect(action(keep!.callback_data)).toBe(`d:${selector}`);
    expect(bench.removeRtspSource.execute).not.toHaveBeenCalled();
    expect(body(ctx, 3)).toContain(copy.detail({
      cameraName: 'Front door',
      host: 'camera.local:554',
      status: copy.statuses['configured-verified'],
      relationship: copy.relationships.allowed,
    }));
  });

  it('reloads the overview when the confirmed selector no longer names a source', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const { ctx } = await openSourceDetail(bench);
    await bench.handler.handleCallback(ctx as never, 'rm', receipt);
    const confirm = removalConfirm(ctx, 2);
    bench.overview.execute.mockResolvedValueOnce(overviewPage({ sources: [] }));

    await bench.handler.handleCallback(ctx as never, confirm, receipt);

    expect(bench.removeRtspSource.execute).not.toHaveBeenCalled();
    expect(body(ctx, 3)).toContain(copy.emptyState.title);
  });

  it('removes nothing for a receipt that is no longer current', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const { ctx } = await openSourceDetail(bench);
    await bench.handler.handleCallback(ctx as never, 'rm', receipt);
    const confirm = removalConfirm(ctx, 2);
    bench.workflows.validateCurrent.mockResolvedValueOnce(false);

    await bench.handler.handleCallback(ctx as never, confirm, receipt);

    expect(bench.removeRtspSource.execute).not.toHaveBeenCalled();
  });

  it('refuses an administrator demoted between the confirmation and the confirm', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const { ctx } = await openSourceDetail(bench);
    await bench.handler.handleCallback(ctx as never, 'rm', receipt);
    const confirm = removalConfirm(ctx, 2);
    const demoted = context({ role: 'user' });

    await bench.handler.handleCallback(demoted as never, confirm, receipt);

    expect(bench.removeRtspSource.execute).not.toHaveBeenCalled();
    expect(demoted.reply).toHaveBeenCalledWith(catalogFor('en').common.adminRequired);
  });
});

/*
 * ─── Losing the race ───────────────────────────────────────────────────────
 *
 * Every stored-source mutation is fenced on a revision the administrator was
 * shown. When the fence loses, the answer is never "try again with the same
 * number": the screen re-reads and the administrator decides again against
 * what is actually there.
 */
describe('CameraSourcesHandler conflicts', () => {
  it('explains and reloads when a replacement lost the race to another replacement', async () => {
    const source = overviewSource({ revision: 4 });
    const bench = setup({ sources: [source] });
    const { ctx } = await openSourceDetail(bench);
    await bench.handler.handleCallback(ctx as never, 'addr', receipt);
    bench.replaceRtspSource.execute.mockRejectedValueOnce(new LiveSourceStateChangedError());
    source.revision = 9;

    const answer = await answerAddress(bench, lastSent(ctx));

    expect(bodies(answer.ctx)).toContain(copy.errors['source-stale']);
    // Reloaded, not remembered: the detail below came from a fresh read.
    expect(bodies(answer.ctx)).toContain(copy.detail({
      cameraName: 'Front door',
      host: 'camera.local:554',
      status: copy.statuses['configured-verified'],
      relationship: copy.relationships.allowed,
    }));
    expect(bench.navigation.complete).not.toHaveBeenCalled();
  });

  it('re-arms the next removal at the revision it just reloaded, never the one that lost', async () => {
    const source = overviewSource({ revision: 4 });
    const bench = setup({ sources: [source] });
    const { ctx, selector } = await openSourceDetail(bench);
    await bench.handler.handleCallback(ctx as never, 'addr', receipt);
    bench.replaceRtspSource.execute.mockRejectedValueOnce(new LiveSourceStateChangedError());
    source.revision = 9;
    const answer = await answerAddress(bench, lastSent(ctx));

    await bench.handler.handleCallback(answer.ctx as never, 'rm', receipt);

    const confirm = removalConfirm(answer.ctx, answer.ctx.reply.mock.calls.length - 1);
    expect(confirm).toBe(`rm:y:${selector}:9`);
    await bench.handler.handleCallback(answer.ctx as never, confirm, receipt);
    expect(bench.removeRtspSource.execute).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 9 }),
    );
  });

  it('explains and reloads when a removal lost the race to a replacement', async () => {
    const source = overviewSource({ revision: 4 });
    const bench = setup({ sources: [source] });
    const { ctx } = await openSourceDetail(bench);
    await bench.handler.handleCallback(ctx as never, 'rm', receipt);
    const confirm = removalConfirm(ctx, 2);
    bench.removeRtspSource.execute.mockRejectedValueOnce(new LiveSourceStateChangedError());
    source.revision = 9;

    await bench.handler.handleCallback(ctx as never, confirm, receipt);

    expect(bodies(ctx)).toContain(copy.errors['source-stale']);
    expect(bench.navigation.complete).not.toHaveBeenCalled();
    // And the way forward is the reloaded detail, not a repeat of the lost bet.
    await bench.handler.handleCallback(ctx as never, 'rm', receipt);
    expect(removalConfirm(ctx, ctx.reply.mock.calls.length - 1)).toContain(':9');
  });

  it('tells the same story when the camera itself is gone', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const { ctx } = await openSourceDetail(bench);
    bench.testRtspSource.execute.mockRejectedValueOnce(new CameraNotFoundError('Front door'));

    await bench.handler.handleCallback(ctx as never, 'test', receipt);

    expect(bodies(ctx)).toContain(copy.errors['source-stale']);
  });
});

/*
 * ─── Categorized failure and recovery ──────────────────────────────────────
 *
 * Copy comes from `presentCameraSourceError`; the controls are that answer
 * intersected with what this screen can actually do. `retry` re-runs an
 * identical request, so it appears only where one still exists — after a
 * credential reply the address is already deleted, and re-asking for it is
 * `change-address`, not `retry`.
 */
const TEST_FAILURES: readonly [string, unknown, readonly string[]][] = [
  ['invalid-address', new InvalidLiveSourceError('bad'), ['change-address', 'back']],
  ['outside-policy', new LiveSourceAddressOutsidePolicyError(), ['change-address', 'back']],
  ['name-taken', new CameraNameTakenError(), ['back']],
  ['host-not-found', new LiveSourceHostNotFoundError(), ['retry', 'change-address', 'back']],
  ['host-unreachable', new LiveSourceHostUnreachableError(), ['retry', 'change-address', 'back']],
  ['authentication-failed', new LiveSourceAuthenticationRejectedError(), ['change-address', 'back']],
  ['tls-verification-failed', new LiveSourceTlsVerificationError(), ['change-address', 'back']],
  ['unsupported-stream', new LiveSourceUnsupportedStreamError(), ['change-address', 'back']],
  ['timed-out', new LiveSourceProbeTimeoutError(), ['retry', 'change-address', 'back']],
  ['probe-failed', new Error('rtsp://operator:hunter2@camera.local exploded'), ['retry', 'change-address', 'back']],
];

describe('CameraSourcesHandler categorized recovery', () => {
  for (const [kind, error, expected] of TEST_FAILURES) {
    it(`offers ${expected.join(', ')} for ${kind}`, async () => {
      const bench = setup({ sources: [overviewSource()] });
      const { ctx, selector } = await openSourceDetail(bench);
      bench.testRtspSource.execute.mockRejectedValueOnce(error);

      await bench.handler.handleCallback(ctx as never, 'test', receipt);

      const last = ctx.reply.mock.calls.length - 1;
      expect(body(ctx, last)).toBe(copy.errors[kind as keyof typeof copy.errors]);
      const rendered = screen(ctx, last);
      expect(rendered.map((button) => button.text).filter((text) =>
        Object.values(copy.actions).includes(text)))
        .toEqual(expected.map((name) => copy.actions[name as keyof typeof copy.actions]));
      const targets: Record<string, string> = {
        retry: 'test',
        'change-address': 'addr',
        back: `d:${selector}`,
      };
      for (const name of expected) {
        const button = rendered.find((candidate) => candidate.text === copy.actions[name as keyof typeof copy.actions]);
        expect(action(button!.callback_data), name).toBe(targets[name]);
      }
      // Recovery is only useful while the receipt still is.
      expect(bench.navigation.complete).not.toHaveBeenCalled();
      expect(bench.handler.hasPending(100, 42, receipt.id)).toBe(true);
      expect(sentJson(ctx)).not.toContain('hunter2');
    });
  }

  it('drops Change address from a removal failure, which changing an address cannot fix', async () => {
    const source = overviewSource({ revision: 4 });
    const bench = setup({ sources: [source] });
    const { ctx, selector } = await openSourceDetail(bench);
    await bench.handler.handleCallback(ctx as never, 'rm', receipt);
    const confirm = removalConfirm(ctx, 2);
    bench.removeRtspSource.execute.mockRejectedValueOnce(new LiveSourceProbeTimeoutError());
    // The source moves while the failed removal is being answered. Retry means
    // "the identical request", and the identical request is fenced on 4 — a
    // retry re-armed from this read would launder a change nobody confirmed
    // into an authorized removal, which is the one thing the fence exists for.
    source.revision = 9;

    await bench.handler.handleCallback(ctx as never, confirm, receipt);

    const last = ctx.reply.mock.calls.length - 1;
    const rendered = screen(ctx, last);
    const offered = rendered.map((button) => button.text);
    expect(offered).toContain(copy.actions.retry);
    expect(offered).toContain(copy.actions.back);
    expect(offered).not.toContain(copy.actions['change-address']);
    expect(action(rendered.find((button) => button.text === copy.actions.retry)!.callback_data))
      .toBe(`rm:y:${selector}:4`);
  });

  it('drops Retry from a failed replacement, whose address is already deleted', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const { ctx, selector } = await openSourceDetail(bench);
    await bench.handler.handleCallback(ctx as never, 'addr', receipt);
    bench.replaceRtspSource.execute.mockRejectedValueOnce(new LiveSourceProbeTimeoutError());

    const answer = await answerAddress(bench, lastSent(ctx));

    const last = answer.ctx.reply.mock.calls.length - 1;
    expect(body(answer.ctx, last)).toBe(copy.errors['timed-out']);
    const offered = screen(answer.ctx, last).map((button) => button.text);
    expect(offered).not.toContain(copy.actions.retry);
    expect(offered).toContain(copy.actions['change-address']);
    expect(offered).toContain(copy.actions.back);
    // T5's hand-off: a failed replacement restores the detail, so Change
    // address still knows which source it is about.
    await bench.handler.handleCallback(answer.ctx as never, 'addr', receipt);
    expect(bench.prompts.created.at(-1)).toMatchObject({ operation: 'replace' });
    expect(screen(answer.ctx, last).find((button) => button.text === copy.actions.back)!.callback_data)
      .toContain(`:src:d:${selector}`);
  });

  it('still renders the feature-state notice, not a recovery keyboard, for an unavailable RTSP', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const { ctx } = await openSourceDetail(bench);
    bench.testRtspSource.execute.mockRejectedValueOnce(new CameraSourceUnavailableError('rtsp-closed'));

    await bench.handler.handleCallback(ctx as never, 'test', receipt);

    const last = ctx.reply.mock.calls.length - 1;
    expect(body(ctx, last)).toBe(copy.rtspClosed);
    expect(screen(ctx, last)).toEqual([]);
  });
});

/*
 * ─── The one failure this screen cannot fix ────────────────────────────────
 *
 * A stale network policy is not an address problem, so the only honest control
 * is the feature workflow's own reinstall — and it is a *handoff*, not a second
 * mutation path: the existing receipt-bound confirmation screen opens, and
 * nothing is installed until the administrator confirms there.
 */
describe('CameraSourcesHandler policy-stale handoff', () => {
  async function failWithStalePolicy(bench: Bench) {
    const opened = await openSourceDetail(bench);
    bench.testRtspSource.execute.mockRejectedValueOnce(new RtspPolicyDigestMismatchError('digest'));
    await bench.handler.handleCallback(opened.ctx as never, 'test', receipt);
    return opened;
  }

  it('offers Reinstall RTSP, and only for a stale policy', async () => {
    const bench = setup({ sources: [overviewSource()] });

    const { ctx } = await failWithStalePolicy(bench);

    const last = ctx.reply.mock.calls.length - 1;
    expect(body(ctx, last)).toBe(copy.errors['policy-stale']);
    const rendered = screen(ctx, last);
    const reinstall = rendered.find((button) => button.text === copy.actions['reinstall-rtsp']);
    expect(reinstall).toBeDefined();
    expect(action(reinstall!.callback_data)).toBe('ri');
    expect(rendered.map((button) => button.text)).not.toContain(copy.actions.retry);
    expect(rendered.map((button) => button.text)).not.toContain(copy.actions['change-address']);
  });

  it('offers it for no other failure kind', async () => {
    for (const [, error] of TEST_FAILURES) {
      const bench = setup({ sources: [overviewSource()] });
      const { ctx } = await openSourceDetail(bench);
      bench.testRtspSource.execute.mockRejectedValueOnce(error);

      await bench.handler.handleCallback(ctx as never, 'test', receipt);

      expect(labels(ctx)).not.toContain(copy.actions['reinstall-rtsp']);
    }
  });

  it('hands the administrator to the existing confirmation and mutates nothing itself', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const { ctx } = await failWithStalePolicy(bench);

    await bench.handler.handleCallback(ctx as never, 'ri', receipt);

    expect(bench.features.handleRtspReinstallEntry).toHaveBeenCalledWith(ctx);
    expect(bench.replaceRtspSource.execute).not.toHaveBeenCalled();
    expect(bench.removeRtspSource.execute).not.toHaveBeenCalled();
    expect(bench.createRtspCamera.execute).not.toHaveBeenCalled();
    expect(bench.attachRtspSource.execute).not.toHaveBeenCalled();
    expect(bench.prompts.createPending).not.toHaveBeenCalled();
    // The sources screen is over for this receipt; the feature workflow owns
    // the conversation from here.
    expect(bench.handler.hasPending(100, 42, receipt.id)).toBe(false);
  });

  it('hands off even while RTSP itself reports unready, which is the point of reinstalling', async () => {
    const availability: FeatureAvailabilityPort = {
      awaitInitialVerification: vi.fn(),
      inspect: vi.fn(),
      requireReady: vi.fn().mockRejectedValue(new FeatureUnavailableError('rtsp', 'needs-attention')),
    };
    const bench = setup({ sources: [overviewSource()], availability });
    const ctx = context();

    await bench.handler.handleCallback(ctx as never, 'ri', receipt);

    expect(bench.features.handleRtspReinstallEntry).toHaveBeenCalledWith(ctx);
  });

  it('says so rather than throwing when no feature workflow is wired', async () => {
    const bench = setup({ sources: [overviewSource()], features: false });
    const { ctx } = await failWithStalePolicy(bench);

    await bench.handler.handleCallback(ctx as never, 'ri', receipt);

    expect(bodies(ctx)).toContain(copy.errors['feature-unavailable']);
  });

  it('refuses the handoff to a non-administrator', async () => {
    const bench = setup({ sources: [overviewSource()] });

    await bench.handler.handleCallback(context({ role: 'user' }) as never, 'ri', receipt);

    expect(bench.features.handleRtspReinstallEntry).not.toHaveBeenCalled();
  });
});

describe('CameraSourcesHandler lifecycle callbacks', () => {
  it('carries no name, camera id, address or credential, and stays inside 64 bytes', async () => {
    const bench = setup({ sources: [overviewSource({ revision: Number.MAX_SAFE_INTEGER })] });
    const { ctx } = await openSourceDetail(bench);
    await bench.handler.handleCallback(ctx as never, 'rm', receipt);
    bench.testRtspSource.execute.mockRejectedValueOnce(new RtspPolicyDigestMismatchError('digest'));
    await bench.handler.handleCallback(ctx as never, 'test', receipt);

    const data = keyboardData(ctx);
    expect(data.some((value) => value.includes(`:src:rm:y:`))).toBe(true);
    expect(data.some((value) => value.endsWith(':src:ri'))).toBe(true);
    for (const value of data) {
      expect(Buffer.byteLength(value, 'utf8'), value).toBeLessThanOrEqual(64);
      expect(value, value).not.toContain('camera-with-private-id');
      expect(value, value).not.toContain('Front door');
      expect(value, value).not.toMatch(/rtsps?:/iu);
      expect(value, value).not.toContain('@');
    }
  });

  /*
   * The widest revision that can exist, routed rather than merely rendered.
   * The confirm arm bounds the decimal, and a bound one digit short would
   * render this control and then refuse to act on it — which looks exactly
   * like a stale button and would never be reported as a bug.
   */
  it('routes a confirmation carrying the widest revision a source can have', async () => {
    const bench = setup({ sources: [overviewSource({ revision: Number.MAX_SAFE_INTEGER })] });
    const { ctx } = await openSourceDetail(bench);
    await bench.handler.handleCallback(ctx as never, 'rm', receipt);
    const confirm = removalConfirm(ctx, 2);
    expect(confirm).toContain(`:${Number.MAX_SAFE_INTEGER}`);

    await bench.handler.handleCallback(ctx as never, confirm, receipt);

    expect(bench.removeRtspSource.execute).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: Number.MAX_SAFE_INTEGER }),
    );
  });

  it('acts on no confirmation whose revision could not be a revision', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const { ctx, selector } = await openSourceDetail(bench);
    const replies = ctx.reply.mock.calls.length;

    for (const forged of [
      `rm:y:${selector}:00000000000000000`,
      // Sixteen digits, so the shape passes — but larger than any revision
      // JavaScript can count to, which is the guard behind the regex.
      `rm:y:${selector}:9999999999999999`,
      `rm:y:${selector}:-1`,
      `rm:y:${selector}:1.5`,
      `rm:y:${selector}:`,
      'rm:y::4',
    ]) {
      await bench.handler.handleCallback(ctx as never, forged, receipt);
    }

    expect(bench.removeRtspSource.execute).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledTimes(replies);
  });
});

/*
 * ─── A prompt no row can back must never reach the chat ────────────────────
 *
 * The worst outcome this workflow has is not a failed install: it is an armed
 * ForceReply that nothing will claim. `handleText` matches a reply against a
 * durable row, so a prompt sent without one is answered with a credential that
 * `promptFor` cannot find, that the next handler receives, and that nothing
 * ever deletes — leaving the camera password sitting in the chat.
 *
 * Two layers keep that unreachable. A stored camera *name* is filtered before
 * it is offered to the model, and the whole selection is checked against the
 * model itself before the first message is sent.
 */

/** How many rendered messages armed a ForceReply. */
function forceReplies(ctx: ReturnType<typeof context>): number {
  return (ctx.reply.mock.calls as unknown[][]).filter((call) => {
    const options = call[1];
    return isRecord(options) && isRecord(options.reply_markup) && options.reply_markup.force_reply === true;
  }).length;
}

/**
 * The `message_id` of the ForceReply this context armed.
 *
 * Not `lastSent`: a prompt that is retracted is followed by the failure notice,
 * so the last message sent is the explanation rather than the prompt. Naming
 * the armed message by its markup is what keeps the retraction assertion about
 * the prompt and not about whatever was rendered after it.
 */
function armedPrompt(ctx: ReturnType<typeof context>): number {
  const index = (ctx.reply.mock.calls as unknown[][]).findIndex((call) => {
    const options = call[1];
    return isRecord(options) && isRecord(options.reply_markup) && options.reply_markup.force_reply === true;
  });
  if (index < 0) throw new Error('the handler armed no prompt');
  return ctx.sent[index];
}

/** Shapes the durable model refuses outright, one per clause of its guard. */
const REFUSED_TEXT: readonly [string, string][] = [
  ['userinfo', 'cam@front'],
  ['a url', 'cam://front'],
  ['an rtsp scheme', 'rtsp:front'],
  ['blank', '   '],
  ['a control character', 'cam\u0001front'],
  ['overlong', 'c'.repeat(200)],
];

describe('CameraSourcesHandler prompts nothing it cannot claim', () => {
  /*
   * Layer one. A camera name is chosen by a human and validated more loosely
   * where cameras are created than the prompt row accepts, so it is filtered
   * rather than trusted — the row names the camera by identifier anyway.
   */
  for (const [label, cameraName] of REFUSED_TEXT) {
    it(`still opens a claimable attach prompt for a camera named with ${label}`, async () => {
      const bench = setup({
        sources: [],
        attachCandidates: [{ cameraId: 'camera-hallway-private-id', cameraName }],
      });
      const ctx = context();
      await bench.handler.handleEntry(ctx as never, { receipt });
      await bench.handler.handleCallback(ctx as never, 'add', receipt);
      await bench.handler.handleCallback(ctx as never, 'add:a', receipt);
      const chosen = screen(ctx, 2).find((button) => button.callback_data.includes(':src:add:s:'));

      await bench.handler.handleCallback(ctx as never, action(chosen!.callback_data), receipt);

      expect(forceReplies(ctx)).toBe(1);
      expect(bench.prompts.created).toHaveLength(1);
      expect(bench.prompts.created[0]).toMatchObject({
        operation: 'attach',
        cameraId: 'camera-hallway-private-id',
        displayName: null,
      });
      // And the prompt it armed is claimable, which is the whole point.
      const answer = await answerAddress(bench, lastSent(ctx));
      expect(answer.claimed).toBe(true);
      expect(bench.messages.delete).toHaveBeenCalledWith(42, 600);
    });

    it(`still opens a claimable replace prompt for a source named with ${label}`, async () => {
      const bench = setup({ sources: [overviewSource({ cameraName })] });
      const { ctx } = await openSourceDetail(bench);

      await bench.handler.handleCallback(ctx as never, 'addr', receipt);

      expect(forceReplies(ctx)).toBe(1);
      expect(bench.prompts.created[0]).toMatchObject({
        operation: 'replace',
        cameraId: 'camera-with-private-id',
        displayName: null,
        expectedRevision: 4,
      });
      const answer = await answerAddress(bench, lastSent(ctx));
      expect(answer.claimed).toBe(true);
      expect(bench.replaceRtspSource.execute).toHaveBeenCalledWith(
        expect.objectContaining({ expectedRevision: 4 }),
      );
    });
  }

  /*
   * Layer two, and the reason layer one is not enough on its own: a camera
   * *identifier* cannot be filtered — the row has to name the camera by it —
   * and identifiers are opaque, with YAML-seeded ones surviving from before
   * they were minted. So the selection is checked against the model before
   * anything is sent, and a refusal costs the administrator a message they can
   * act on rather than a credential they cannot retract.
   */
  for (const [label, cameraId] of REFUSED_TEXT) {
    it(`sends no prompt at all for a camera identified with ${label}`, async () => {
      const bench = setup({
        sources: [],
        attachCandidates: [{ cameraId, cameraName: 'Hallway' }],
      });
      const ctx = context();
      await bench.handler.handleEntry(ctx as never, { receipt });
      await bench.handler.handleCallback(ctx as never, 'add', receipt);
      await bench.handler.handleCallback(ctx as never, 'add:a', receipt);
      const chosen = screen(ctx, 2).find((button) => button.callback_data.includes(':src:add:s:'));

      await bench.handler.handleCallback(ctx as never, action(chosen!.callback_data), receipt);

      expect(forceReplies(ctx)).toBe(0);
      expect(bench.prompts.createPending).not.toHaveBeenCalled();
      // Not even the notice: it exists to precede a prompt that is coming.
      expect(bodies(ctx)).not.toContain(copy.prompts.credential);
      expect(bodies(ctx)).not.toContain('🔒');
      expect(bodies(ctx)).toContain(copy.errors['probe-failed']);

      // And an address typed at the failure anyway is claimed by nobody, which
      // is safe precisely because no prompt was ever armed to invite it.
      const stray = context({ text: SECRET_URL, messageId: 600, replyTo: lastSent(ctx) });
      await expect(bench.handler.handleText(stray as never)).resolves.toBe(false);
      expect(bench.messages.delete).not.toHaveBeenCalled();
    });
  }

  /*
   * The same hole reached through a different door. The shape was already
   * accepted, so the store itself refused — and a ForceReply is already in the
   * chat. It is retracted rather than left inviting a credential that no row
   * could ever claim.
   */
  it('retracts the prompt it just sent when the durable row cannot be written', async () => {
    const prompts = promptStore();
    prompts.createPending.mockRejectedValueOnce(new Error('database is locked'));
    const bench = setup({ sources: [overviewSource()], prompts });
    const { ctx } = await openSourceDetail(bench);

    await bench.handler.handleCallback(ctx as never, 'addr', receipt);

    const armed = armedPrompt(ctx);
    expect(bench.messages.delete).toHaveBeenCalledWith(42, armed);
    // Retracted first, explained second: the order the administrator needs.
    expect(bench.messages.delete.mock.invocationCallOrder[0]).toBeLessThan(
      (ctx.reply.mock.invocationCallOrder).at(-1)!,
    );
    expect(bodies(ctx)).toContain(copy.errors['probe-failed']);
    const stray = context({ text: SECRET_URL, messageId: 600, replyTo: armed });
    await expect(bench.handler.handleText(stray as never)).resolves.toBe(false);
    expect(bench.replaceRtspSource.execute).not.toHaveBeenCalled();
  });

  it('retries the retraction once when Telegram refuses it', async () => {
    const prompts = promptStore();
    prompts.createPending.mockRejectedValueOnce(new Error('database is locked'));
    const bench = setup({ sources: [overviewSource()], prompts });
    bench.messages.delete
      .mockRejectedValueOnce(new CameraSourceMessageDeletionError())
      .mockResolvedValueOnce(undefined);
    const { ctx } = await openSourceDetail(bench);

    await bench.handler.handleCallback(ctx as never, 'addr', receipt);

    expect(bench.messages.delete).toHaveBeenCalledTimes(2);
  });
});


/*
 * ─── Routing has to outlive the screen ─────────────────────────────────────
 *
 * A durable row is not enough on its own. `handleText` learns which receipt a
 * reply belongs to from `promptFor`, so a prompt whose *routing* entry is gone
 * lands in exactly the state the pre-send checks exist to prevent: the row is
 * `pending` and would claim cleanly, but nothing looks it up, the reply is
 * handed to the next handler, and the credential is never deleted.
 *
 * These are interleavings rather than sequences, which is what every other test
 * in this file is. An address prompt is armed and then something ordinary
 * happens in the chat before the administrator answers it — Telegram keeps old
 * inline keyboards live forever, so pressing one is not an edge case.
 */
describe('CameraSourcesHandler keeps a prompt routable across other screens', () => {
  /** Arms an address prompt from the detail of the one source. */
  async function armReplace(bench: Bench) {
    const opened = await openSourceDetail(bench);
    await bench.handler.handleCallback(opened.ctx as never, 'addr', receipt);
    bench.messages.delete.mockClear();
    return { ctx: opened.ctx, promptMessageId: lastSent(opened.ctx) };
  }

  const INTERRUPTIONS: readonly [string, (bench: Bench, ctx: ReturnType<typeof context>) => Promise<void>][] = [
    ['a stale overview button is pressed', async (bench, ctx) => {
      await bench.handler.handleCallback(ctx as never, 'over', receipt);
    }],
    ['a stale source row is pressed', async (bench, ctx) => {
      const row = screen(ctx, 0).find((button) => button.callback_data.includes(':src:d:'));
      await bench.handler.handleCallback(ctx as never, action(row!.callback_data), receipt);
    }],
    ['Sources is re-opened from the dashboard', async (bench, ctx) => {
      await bench.handler.handleEntry(ctx as never, { receipt });
    }],
  ];

  for (const [label, interrupt] of INTERRUPTIONS) {
    it(`still claims and deletes an address answered after ${label}`, async () => {
      const bench = setup({ sources: [overviewSource()] });
      const armed = await armReplace(bench);

      await interrupt(bench, armed.ctx);
      const answer = await answerAddress(bench, armed.promptMessageId);

      expect(answer.claimed).toBe(true);
      expect(bench.messages.delete).toHaveBeenCalledWith(42, 600);
      expect(bench.replaceRtspSource.execute).toHaveBeenCalledWith(
        expect.objectContaining({ expectedRevision: 4 }),
      );
    });

    it(`still claims a name answered after ${label}`, async () => {
      const bench = setup({ sources: [overviewSource()] });
      const ctx = context();
      await bench.handler.handleEntry(ctx as never, { receipt });
      await bench.handler.handleCallback(ctx as never, 'add', receipt);
      const promptMessageId = lastSent(ctx);

      await interrupt(bench, ctx);
      const naming = context({ text: 'Side gate', messageId: 500, replyTo: promptMessageId });

      await expect(bench.handler.handleText(naming as never)).resolves.toBe(true);
      expect(bench.prompts.created.at(-1)).toMatchObject({ phase: 'credential', displayName: 'Side gate' });
    });
  }

  /*
   * The other half of the same rule, and the reason the routing entry cannot
   * simply be made immortal: one workflow at a time per chat. A prompt left
   * over from a *superseded* receipt must still find nothing, because resuming
   * it would run an install the administrator has already navigated away from.
   */
  it('still refuses a reply to a prompt whose workflow was superseded', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const armed = await armReplace(bench);
    const newer = { ...receipt, id: 'zyxwvutsrqponmlk' };

    await bench.handler.handleEntry(context() as never, { receipt: newer });
    const answer = await answerAddress(bench, armed.promptMessageId);

    expect(answer.claimed).toBe(false);
    expect(bench.replaceRtspSource.execute).not.toHaveBeenCalled();
  });
});

/*
 * ─── Leaving the workflow ends its prompts ─────────────────────────────────
 *
 * A prompt now outlives the screen that armed it, which is the point — but not
 * the workflow itself. `ri` is reachable while an address prompt is open: a
 * *test* failure renders it without consuming anything, so pressing Change
 * address and then the older Reinstall control is an ordinary sequence.
 *
 * Forgetting the prompt there would leave a ForceReply nothing can claim;
 * remembering it would let a workflow the administrator has left run an
 * install after they left it. So the message is retracted, and the routing is
 * dropped only once it is provably gone.
 */
describe('CameraSourcesHandler retracts prompts it walks away from', () => {
  async function armAddressThenStalePolicy(bench: Bench) {
    const opened = await openSourceDetail(bench);
    bench.testRtspSource.execute.mockRejectedValueOnce(new RtspPolicyDigestMismatchError('digest'));
    await bench.handler.handleCallback(opened.ctx as never, 'test', receipt);
    await bench.handler.handleCallback(opened.ctx as never, 'addr', receipt);
    const promptMessageId = lastSent(opened.ctx);
    bench.messages.delete.mockClear();
    return { ctx: opened.ctx, promptMessageId };
  }

  it('deletes the open address prompt before handing over, and installs nothing afterwards', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const armed = await armAddressThenStalePolicy(bench);

    await bench.handler.handleCallback(armed.ctx as never, 'ri', receipt);

    expect(bench.messages.delete).toHaveBeenCalledWith(42, armed.promptMessageId);
    expect(bench.features.handleRtspReinstallEntry).toHaveBeenCalledWith(armed.ctx);
    expect(bench.messages.delete.mock.invocationCallOrder[0]).toBeLessThan(
      bench.features.handleRtspReinstallEntry.mock.invocationCallOrder[0],
    );

    // The prompt is gone, so an address answered at it afterwards runs nothing.
    const answer = await answerAddress(bench, armed.promptMessageId);
    expect(bench.replaceRtspSource.execute).not.toHaveBeenCalled();
    expect(answer.claimed).toBe(false);
  });

  /*
   * The residual, handled rather than assumed away. If Telegram will not delete
   * the prompt it is still in the chat and still answerable, so its routing is
   * kept: the durable row is terminal, `claimReply` answers `late`, and the
   * reply is deleted as cleanup without authorising anything.
   */
  it('keeps the prompt routable for cleanup when the retraction fails', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const armed = await armAddressThenStalePolicy(bench);
    bench.messages.delete.mockRejectedValue(new CameraSourceMessageDeletionError());

    await bench.handler.handleCallback(armed.ctx as never, 'ri', receipt);
    bench.messages.delete.mockReset();
    bench.messages.delete.mockResolvedValue(undefined);
    const answer = await answerAddress(bench, armed.promptMessageId);

    expect(answer.claimed).toBe(true);
    expect(bench.messages.delete).toHaveBeenCalledWith(42, 600);
    expect(bench.replaceRtspSource.execute).not.toHaveBeenCalled();
  });
});

/*
 * The residual of the retraction in `rememberPrompt`, which needs two
 * independent failures — the store refusing the row *and* both delete attempts
 * failing — but lands in exactly the state layer three exists to prevent if it
 * is left alone. The prompt is still armed and still answerable, so its routing
 * is kept and the reply is claimed for deletion even though no row was written.
 */
describe('CameraSourcesHandler when a prompt cannot be retracted', () => {
  function stuck() {
    const prompts = promptStore();
    prompts.createPending.mockRejectedValueOnce(new Error('database is locked'));
    const bench = setup({ sources: [overviewSource()], prompts });
    bench.messages.delete.mockRejectedValue(new CameraSourceMessageDeletionError());
    return bench;
  }

  it('still deletes an address replied to a prompt that no row backs', async () => {
    const bench = stuck();
    const { ctx } = await openSourceDetail(bench);
    await bench.handler.handleCallback(ctx as never, 'addr', receipt);
    const armed = armedPrompt(ctx);
    bench.messages.delete.mockReset();
    bench.messages.delete.mockResolvedValue(undefined);

    const answer = await answerAddress(bench, armed);

    expect(answer.claimed).toBe(true);
    expect(bench.messages.delete).toHaveBeenCalledWith(42, 600);
    // Cleanup only: no row authorised anything.
    expect(bench.replaceRtspSource.execute).not.toHaveBeenCalled();
    expect(bench.createRtspCamera.execute).not.toHaveBeenCalled();
  });

  it('drops the routing when the retraction does succeed, so nothing lingers', async () => {
    const prompts = promptStore();
    prompts.createPending.mockRejectedValueOnce(new Error('database is locked'));
    const bench = setup({ sources: [overviewSource()], prompts });
    const { ctx } = await openSourceDetail(bench);

    await bench.handler.handleCallback(ctx as never, 'addr', receipt);

    const answer = await answerAddress(bench, armedPrompt(ctx));
    expect(answer.claimed).toBe(false);
  });
});

/*
 * Answering the same address prompt twice.
 *
 * The durable compare-and-swap refuses to install anything a second time, but
 * the second message is still a pasted credential and still has to leave the
 * chat. That cleanup is reached only if the reply is routed at all, which is
 * why answering a prompt does not spend its routing.
 */
describe('CameraSourcesHandler second replies', () => {
  it('deletes an address pasted twice at the same prompt, and installs once', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const { promptMessageId } = await openCredentialPrompt(bench);
    await answerAddress(bench, promptMessageId);
    bench.messages.delete.mockClear();
    bench.createRtspCamera.execute.mockClear();

    const again = await answerAddress(bench, promptMessageId, { messageId: 601 });

    expect(again.claimed).toBe(true);
    expect(bench.messages.delete).toHaveBeenCalledWith(42, 601);
    expect(bench.createRtspCamera.execute).not.toHaveBeenCalled();
    expect(bench.attachRtspSource.execute).not.toHaveBeenCalled();
    expect(bench.replaceRtspSource.execute).not.toHaveBeenCalled();
  });

  it('retries that deletion once when Telegram refuses it', async () => {
    const bench = setup({ sources: [overviewSource()] });
    const { promptMessageId } = await openCredentialPrompt(bench);
    await answerAddress(bench, promptMessageId);
    bench.messages.delete.mockClear();
    bench.messages.delete
      .mockRejectedValueOnce(new CameraSourceMessageDeletionError())
      .mockResolvedValueOnce(undefined);

    await answerAddress(bench, promptMessageId, { messageId: 601 });

    expect(bench.messages.delete).toHaveBeenCalledTimes(2);
  });
});
