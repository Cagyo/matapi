import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { InvalidLiveSourceError } from './errors/invalid-live-source.error';

const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;

export type LiveSourceSecuritySettings =
  | { scheme: 'rtsp'; tlsMode: 'none' }
  | { scheme: 'rtsps'; tlsMode: 'strict' };

export type LiveSourceTransportSettings =
  | { transport: 'auto' }
  | { transport: 'tcp' }
  | { transport: 'udp' };

export type LiveSourceProfileSettings =
  | { profile: 'eco' }
  | { profile: 'balanced' }
  | { profile: 'quality' };

export type LiveSourceSettings = Readonly<
  LiveSourceSecuritySettings &
    LiveSourceTransportSettings &
    LiveSourceProfileSettings & {
      videoOnly: true;
      maxConverters: 1;
      maxViewers: 2;
      startTimeoutMs: number;
      stopTimeoutMs: number;
      substream: string | null;
    }
>;

export interface LiveSourceCredentialPayload {
  primaryUrl: string;
  substreamUrl: string | null;
}

export interface CreateLiveSourceInput {
  cameraId: string;
  url: string;
  tlsMode?: LiveSourceSecuritySettings['tlsMode'];
  transport?: LiveSourceTransportSettings['transport'];
  profile?: LiveSourceProfileSettings['profile'];
  substream?: string | null;
  ready?: boolean;
}

export interface LiveSourceSummary {
  scheme: LiveSourceSecuritySettings['scheme'];
  host: string;
  transport: LiveSourceTransportSettings['transport'];
  tlsMode: LiveSourceSecuritySettings['tlsMode'];
  profile: LiveSourceProfileSettings['profile'];
  substreamHost: string | null;
  ready: boolean;
}

interface ParsedEndpoint {
  scheme: LiveSourceSecuritySettings['scheme'];
  normalizedUrl: string;
  credentialUrl: string;
}

export class LiveSource {
  readonly cameraId: string;
  readonly normalizedUrl: string;
  readonly settings: LiveSourceSettings;
  readonly ready: boolean;
  readonly #credentialPayload: Readonly<LiveSourceCredentialPayload>;

  private constructor(input: {
    cameraId: string;
    normalizedUrl: string;
    settings: LiveSourceSettings;
    ready: boolean;
    credentialPayload: LiveSourceCredentialPayload;
  }) {
    this.cameraId = input.cameraId;
    this.normalizedUrl = input.normalizedUrl;
    this.settings = Object.freeze(input.settings);
    this.ready = input.ready;
    this.#credentialPayload = Object.freeze(input.credentialPayload);
  }

  get transport(): LiveSourceTransportSettings['transport'] {
    return this.settings.transport;
  }

  get tlsMode(): LiveSourceSecuritySettings['tlsMode'] {
    return this.settings.tlsMode;
  }

  get profile(): LiveSourceProfileSettings['profile'] {
    return this.settings.profile;
  }

  get substream(): string | null {
    return this.settings.substream;
  }

  static create(input: CreateLiveSourceInput): LiveSource {
    if (typeof input !== 'object' || input === null) {
      throw new InvalidLiveSourceError('input is malformed');
    }
    if (
      typeof input.cameraId !== 'string' ||
      !input.cameraId.trim() ||
      containsControlCharacter(input.cameraId)
    ) {
      throw new InvalidLiveSourceError('camera identifier is malformed');
    }
    if (typeof input.url !== 'string') {
      throw new InvalidLiveSourceError('URL is malformed');
    }
    if (
      input.substream !== undefined &&
      input.substream !== null &&
      typeof input.substream !== 'string'
    ) {
      throw new InvalidLiveSourceError('substream URL is malformed');
    }
    if (input.ready !== undefined && typeof input.ready !== 'boolean') {
      throw new InvalidLiveSourceError('readiness is malformed');
    }

    const primary = parseEndpoint(input.url);
    const security = parseSecurity(primary.scheme, input.tlsMode);
    const substream =
      input.substream !== undefined && input.substream !== null
        ? parseEndpoint(input.substream)
        : null;
    if (substream !== null && substream.scheme !== primary.scheme) {
      throw new InvalidLiveSourceError(
        'primary and substream TLS schemes must match',
      );
    }
    const transport = parseTransport(input.transport ?? 'tcp');
    const profile = parseProfile(input.profile ?? 'eco');

    return new LiveSource({
      cameraId: input.cameraId.trim(),
      normalizedUrl: primary.normalizedUrl,
      settings: {
        ...security,
        transport,
        profile,
        videoOnly: true,
        maxConverters: 1,
        maxViewers: 2,
        startTimeoutMs: START_TIMEOUT_MS,
        stopTimeoutMs: STOP_TIMEOUT_MS,
        substream: substream?.normalizedUrl ?? null,
      },
      ready: input.ready ?? false,
      credentialPayload: {
        primaryUrl: primary.credentialUrl,
        substreamUrl: substream?.credentialUrl ?? null,
      },
    });
  }

  static restore(input: {
    cameraId: string;
    normalizedUrl: string;
    settings: LiveSourceSettings;
    ready: boolean;
    credentialPayload: LiveSourceCredentialPayload;
  }): LiveSource {
    const restored = LiveSource.create({
      cameraId: input.cameraId,
      url: input.credentialPayload.primaryUrl,
      tlsMode: input.settings.tlsMode,
      transport: input.settings.transport,
      profile: input.settings.profile,
      substream: input.credentialPayload.substreamUrl,
      ready: input.ready,
    });
    if (
      restored.normalizedUrl !== input.normalizedUrl ||
      JSON.stringify(restored.settings) !== JSON.stringify(input.settings)
    ) {
      throw new InvalidLiveSourceError('stored metadata is inconsistent');
    }
    return restored;
  }

  credentialPayload(): LiveSourceCredentialPayload {
    return { ...this.#credentialPayload };
  }

  summary(): LiveSourceSummary {
    const parsed = new URL(this.normalizedUrl);
    return {
      scheme: this.settings.scheme,
      host: parsed.host,
      transport: this.settings.transport,
      tlsMode: this.settings.tlsMode,
      profile: this.settings.profile,
      substreamHost: this.settings.substream
        ? new URL(this.settings.substream).host
        : null,
      ready: this.ready,
    };
  }
}

function parseEndpoint(rawUrl: string): ParsedEndpoint {
  if (containsControlCharacter(rawUrl) || rawUrl.includes('\\')) {
    throw new InvalidLiveSourceError('URL contains an ambiguous character');
  }
  const authorityMatch = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/iu.exec(rawUrl);
  if (authorityMatch === null) {
    throw new InvalidLiveSourceError('URL is malformed');
  }
  const scheme = parseScheme(`${authorityMatch[1].toLowerCase()}:`);

  const suffix = rawUrl.slice(authorityMatch[0].length);
  let authorityUrl: URL;
  try {
    authorityUrl = new URL(`http://${authorityMatch[2]}${suffix || '/'}`);
  } catch {
    throw new InvalidLiveSourceError('URL is malformed');
  }

  const hostname = canonicalizeHostname(authorityUrl.hostname);
  const port = parseAuthorityPort(authorityMatch[2]);
  const canonicalAuthority = `${hostname}${port ? `:${port}` : ''}`;
  const userinfo = canonicalizeUserinfo(authorityMatch[2], authorityUrl);
  return {
    scheme,
    normalizedUrl: `${scheme}://${canonicalAuthority}`,
    credentialUrl: `${scheme}://${userinfo}${canonicalAuthority}${canonicalizeSuffix(
      suffix,
      authorityUrl,
    )}`,
  };
}

function canonicalizeSuffix(rawSuffix: string, parsed: URL): string {
  const queryIndex = rawSuffix.indexOf('?');
  const fragmentIndex = rawSuffix.indexOf('#');
  const hasQuery =
    queryIndex >= 0 && (fragmentIndex < 0 || queryIndex < fragmentIndex);
  const query = parsed.search || (hasQuery ? '?' : '');
  const fragment = parsed.hash || (fragmentIndex >= 0 ? '#' : '');
  return `${parsed.pathname}${query}${fragment}`;
}

function canonicalizeUserinfo(authority: string, parsed: URL): string {
  const separator = authority.lastIndexOf('@');
  if (separator < 0) return '';
  const rawUserinfo = authority.slice(0, separator);
  const password = rawUserinfo.includes(':') ? `:${parsed.password}` : '';
  return `${parsed.username}${password}@`;
}

function parseAuthorityPort(authority: string): string {
  const hostAndPort = authority.slice(authority.lastIndexOf('@') + 1);
  let rawPort: string | null = null;
  if (hostAndPort.startsWith('[')) {
    const closingBracket = hostAndPort.indexOf(']');
    const suffix = hostAndPort.slice(closingBracket + 1);
    if (suffix) rawPort = suffix.startsWith(':') ? suffix.slice(1) : '';
  } else {
    const separator = hostAndPort.lastIndexOf(':');
    if (separator >= 0) rawPort = hostAndPort.slice(separator + 1);
  }
  if (rawPort === null) return '';
  if (!/^\d+$/u.test(rawPort)) {
    throw new InvalidLiveSourceError('URL port is unusable');
  }
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new InvalidLiveSourceError('URL port is unusable');
  }
  return String(port);
}

function canonicalizeHostname(rawHostname: string): string {
  if (rawHostname.startsWith('[') && rawHostname.endsWith(']')) {
    const literal = rawHostname.slice(1, -1).toLowerCase();
    if (isIP(literal) !== 6) {
      throw new InvalidLiveSourceError('URL host is unusable');
    }
    return `[${literal}]`;
  }

  const withoutTrailingDot = rawHostname.replace(/\.+$/u, '').toLowerCase();
  const hostname = domainToASCII(withoutTrailingDot);
  if (!hostname || hostname.length > 253) {
    throw new InvalidLiveSourceError('URL host is unusable');
  }
  if (isIP(hostname) === 4) return hostname;

  const labels = hostname.split('.');
  if (
    labels.some(
      (label) =>
        !label ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
    )
  ) {
    throw new InvalidLiveSourceError('URL host is unusable');
  }
  return hostname;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function parseScheme(protocol: string): LiveSourceSecuritySettings['scheme'] {
  if (protocol === 'rtsp:') return 'rtsp';
  if (protocol === 'rtsps:') return 'rtsps';
  throw new InvalidLiveSourceError('URL scheme must be rtsp or rtsps');
}

function parseSecurity(
  scheme: LiveSourceSecuritySettings['scheme'],
  requestedMode: CreateLiveSourceInput['tlsMode'],
): LiveSourceSecuritySettings {
  if (scheme === 'rtsp') {
    if (requestedMode !== undefined && requestedMode !== 'none') {
      throw new InvalidLiveSourceError('RTSP does not support a TLS mode');
    }
    return { scheme, tlsMode: 'none' };
  }
  if (requestedMode !== undefined && requestedMode !== 'strict') {
    throw new InvalidLiveSourceError(
      'RTSPS supports strict CA and hostname verification only',
    );
  }
  return { scheme, tlsMode: 'strict' };
}

function parseTransport(
  transport: LiveSourceTransportSettings['transport'],
): LiveSourceTransportSettings['transport'] {
  if (transport === 'auto' || transport === 'tcp' || transport === 'udp') {
    return transport;
  }
  throw new InvalidLiveSourceError('transport is unsupported');
}

function parseProfile(
  profile: LiveSourceProfileSettings['profile'],
): LiveSourceProfileSettings['profile'] {
  if (profile === 'eco' || profile === 'balanced' || profile === 'quality') {
    return profile;
  }
  throw new InvalidLiveSourceError('output profile is unsupported');
}
