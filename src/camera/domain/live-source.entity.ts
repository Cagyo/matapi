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
  ready: boolean;
}

export class LiveSource {
  readonly cameraId: string;
  readonly normalizedUrl: string;
  readonly settings: LiveSourceSettings;
  readonly ready: boolean;

  private constructor(input: {
    cameraId: string;
    normalizedUrl: string;
    settings: LiveSourceSettings;
    ready: boolean;
  }) {
    this.cameraId = input.cameraId;
    this.normalizedUrl = input.normalizedUrl;
    this.settings = Object.freeze(input.settings);
    this.ready = input.ready;
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
    if (!input.cameraId.trim() || containsControlCharacter(input.cameraId)) {
      throw new InvalidLiveSourceError('camera identifier is malformed');
    }
    if (containsControlCharacter(input.url)) {
      throw new InvalidLiveSourceError('URL contains a control character');
    }

    let parsed: URL;
    try {
      parsed = new URL(input.url);
    } catch {
      throw new InvalidLiveSourceError('URL is malformed');
    }

    const scheme = parseScheme(parsed.protocol);
    if (!parsed.hostname) {
      throw new InvalidLiveSourceError('URL host is required');
    }

    const security = parseSecurity(scheme, input.tlsMode);
    const transport = parseTransport(input.transport ?? 'tcp');
    const profile = parseProfile(input.profile ?? 'eco');
    const substream = input.substream ?? null;
    if (substream !== null && containsControlCharacter(substream)) {
      throw new InvalidLiveSourceError('substream contains a control character');
    }

    return new LiveSource({
      cameraId: input.cameraId,
      normalizedUrl: `${scheme}://${parsed.hostname.toLowerCase()}${
        parsed.port ? `:${parsed.port}` : ''
      }`,
      settings: {
        ...security,
        transport,
        profile,
        videoOnly: true,
        maxConverters: 1,
        maxViewers: 2,
        startTimeoutMs: START_TIMEOUT_MS,
        stopTimeoutMs: STOP_TIMEOUT_MS,
        substream,
      },
      ready: input.ready ?? false,
    });
  }

  summary(): LiveSourceSummary {
    const parsed = new URL(this.normalizedUrl);
    return {
      scheme: this.settings.scheme,
      host: parsed.host,
      transport: this.settings.transport,
      ready: this.ready,
    };
  }
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
