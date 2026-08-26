import { Inject, Injectable } from '@nestjs/common';
import { cameraNameKey } from '../domain/camera-name-key';
import {
  LIVE_SOURCE_POLICY_EVALUATOR,
  type LiveSourcePolicyEvaluatorPort,
  type RtspSourcePolicyNetwork,
  type RtspSourcePolicyRelationship,
} from '../domain/ports/live-source-policy-evaluator.port';
import {
  LIVE_SOURCE_REPOSITORY,
  type LiveSourceRepositoryPort,
  type RedactedLiveSource,
} from '../domain/ports/live-source-repository.port';
import {
  MEDIA_REPOSITORY,
  type MediaRepositoryPort,
} from '../domain/ports/media-repository.port';
import { RTSP_SOURCE_CAMERA_TYPE } from '../domain/ports/rtsp-source-configuration.port';
import {
  RTSP_POLICY_STATUS,
  type RtspPolicyStatusPort,
} from '../../features/domain/ports/rtsp-policy-status.port';

export const RTSP_SOURCE_OVERVIEW_PAGE_SIZE = 5;

/**
 * Hard ceiling on a caller-supplied page size. Every row on the page costs at
 * least one DNS resolution, so an unbounded `pageSize` would be the very
 * whole-table fan-out that paginating exists to prevent.
 */
export const RTSP_SOURCE_OVERVIEW_MAX_PAGE_SIZE = RTSP_SOURCE_OVERVIEW_PAGE_SIZE * 4;

/**
 * How many rows are resolved at once.
 *
 * `dns.lookup` is `getaddrinfo` on the libuv threadpool, four slots by default,
 * while each row's resolver budget starts when its evaluation does. Releasing a
 * whole page at once would let later rows spend that budget sitting in the
 * queue and time out without the resolver ever being asked — reporting
 * `needs-attention` for a camera that is perfectly fine. In waves, the budget
 * measures resolver latency rather than queue depth.
 */
export const RTSP_SOURCE_OVERVIEW_RESOLUTION_WAVE = 4;

/**
 * What an operator has to do about one source, most blocking first.
 *
 * `configured-verified` is the only state that claims the source is usable, and
 * it is never inferred from stored metadata alone.
 */
export type RtspSourceOperationalState =
  | 'configured-verified'
  | 'credentials-required'
  | 'not-ready'
  | 'needs-attention';

export interface RtspSourceOverview extends RedactedLiveSource {
  /** Where the host resolves *now*, not where it resolved at verification. */
  relationship: RtspSourcePolicyRelationship;
  operationalState: RtspSourceOperationalState;
  /**
   * The digest currently in force, which is `null` unless the installed policy
   * is `ready`: a stale or unavailable policy attests to nothing, so no stored
   * digest may match it.
   */
  currentPolicyDigest: string | null;
  needsReverification: boolean;
}

export interface RtspSourcesOverviewPage {
  policy: {
    state: 'ready' | 'stale' | 'unavailable';
    networks: readonly RtspSourcePolicyNetwork[];
  };
  sources: readonly RtspSourceOverview[];
  attachCandidates: readonly { cameraId: string; cameraName: string }[];
  page: number;
  pageCount: number;
}

export interface RtspSourcesOverviewRequest {
  page?: number;
  pageSize?: number;
}

/**
 * The read-only status view behind the source menu.
 *
 * Everything here is credential-free by construction: it reads the redacted
 * repository projection and the redacted policy projection, and hands the
 * evaluator a host rather than a URL. It never calls `loadForStream`, never
 * decrypts, and writes nothing — a source whose status is wrong is reported,
 * not repaired.
 *
 * It reads `inspect()` rather than `requireCurrent()` on purpose: an operator
 * whose policy has gone stale most needs to see the installed networks and the
 * reverification each source now owes, which a throw would replace with
 * nothing.
 */
@Injectable()
export class GetRtspSourceOverviewUseCase {
  constructor(
    @Inject(LIVE_SOURCE_REPOSITORY)
    private readonly repository: LiveSourceRepositoryPort,
    @Inject(MEDIA_REPOSITORY) private readonly media: MediaRepositoryPort,
    @Inject(RTSP_POLICY_STATUS) private readonly policy: RtspPolicyStatusPort,
    @Inject(LIVE_SOURCE_POLICY_EVALUATOR)
    private readonly evaluator: LiveSourcePolicyEvaluatorPort,
  ) {}

  async execute(
    request: RtspSourcesOverviewRequest = {},
  ): Promise<RtspSourcesOverviewPage> {
    const [status, stored, cameras] = await Promise.all([
      this.policy.inspect(),
      this.repository.listRedacted(),
      this.media.listCameras(),
    ]);
    const networks = status.networks;
    const currentPolicyDigest = status.state === 'ready' ? status.digest : null;

    const ordered = [...stored].sort(compareSources);
    const pageSize = normalizePageSize(request.pageSize);
    const pageCount = Math.max(1, Math.ceil(ordered.length / pageSize));
    const page = clampPage(request.page, pageCount);
    const start = (page - 1) * pageSize;

    // Only the visible page is resolved: an overview must not fan a DNS query
    // out across every stored source to render five rows. Even that page goes
    // out in waves, so a slow resolver cannot make later rows expire in a
    // queue rather than on an answer.
    const visible = ordered.slice(start, start + pageSize);
    const sources: RtspSourceOverview[] = [];
    for (
      let offset = 0;
      offset < visible.length;
      offset += RTSP_SOURCE_OVERVIEW_RESOLUTION_WAVE
    ) {
      const wave = await Promise.all(
        visible
          .slice(offset, offset + RTSP_SOURCE_OVERVIEW_RESOLUTION_WAVE)
          .map((source) => this.describe(source, networks, currentPolicyDigest)),
      );
      sources.push(...wave);
    }

    const withSource = new Set(stored.map((source) => source.cameraId));
    return {
      policy: { state: status.state, networks },
      sources,
      attachCandidates: cameras
        .filter(
          (camera) =>
            camera.enabled &&
            camera.type !== RTSP_SOURCE_CAMERA_TYPE &&
            !withSource.has(camera.id),
        )
        .map((camera) => ({ cameraId: camera.id, cameraName: camera.name })),
      page,
      pageCount,
    };
  }

  private async describe(
    source: RedactedLiveSource,
    networks: readonly RtspSourcePolicyNetwork[],
    currentPolicyDigest: string | null,
  ): Promise<RtspSourceOverview> {
    // Both authorities, not just the primary: enforcement validates the
    // substream too, and for the `eco` profile the substream is the URL
    // actually streamed. Evaluating only `host` would render `allowed` for a
    // source whose substream has rebound out of policy.
    const hosts = [source.summary.host, source.summary.substreamHost].filter(
      (host): host is string => typeof host === 'string' && host.length > 0,
    );
    const relationship = await this.evaluator.evaluate(hosts, { networks });
    // Verification is an attestation, never an inference: a probe passed
    // (`verifiedAt`), under a policy that is still the one in force
    // (`policyDigest`), for a host that still resolves inside it. The stored
    // `ready` flag is metadata and proves none of the three.
    const verified =
      source.verifiedAt !== null &&
      source.policyDigest !== null &&
      currentPolicyDigest !== null &&
      source.policyDigest === currentPolicyDigest;
    // The stored digest differing is one way to owe a reverification; never
    // having passed a probe is the other, and a source that no longer resolves
    // inside the policy owes one whatever its attestation says.
    const needsReverification = !verified || relationship !== 'allowed';
    return {
      ...source,
      relationship,
      operationalState: operationalState(source, verified, relationship),
      currentPolicyDigest,
      needsReverification,
    };
  }
}

function operationalState(
  source: RedactedLiveSource,
  verified: boolean,
  relationship: RtspSourcePolicyRelationship,
): RtspSourceOperationalState {
  // Precedence, most blocking first: without a credential nothing can start, so
  // that answer outranks the readiness flag it usually travels with.
  if (!source.hasCredential) return 'credentials-required';
  if (!source.summary.ready) return 'not-ready';
  if (verified && relationship === 'allowed') return 'configured-verified';
  return 'needs-attention';
}

/**
 * Page order decides which rows get resolved, so it is the canonical name key
 * — not the raw display name — that orders them: sorting on UTF-16 code units
 * would put every capitalized name ahead of every lowercase one.
 */
function compareSources(left: RedactedLiveSource, right: RedactedLiveSource): number {
  const byName = cameraNameKey(left.cameraName).localeCompare(
    cameraNameKey(right.cameraName),
  );
  if (byName !== 0) return byName;
  if (left.cameraId === right.cameraId) return 0;
  return left.cameraId < right.cameraId ? -1 : 1;
}

function normalizePageSize(requested: number | undefined): number {
  if (typeof requested !== 'number' || !Number.isSafeInteger(requested) || requested < 1) {
    return RTSP_SOURCE_OVERVIEW_PAGE_SIZE;
  }
  return Math.min(requested, RTSP_SOURCE_OVERVIEW_MAX_PAGE_SIZE);
}

function clampPage(requested: number | undefined, pageCount: number): number {
  if (typeof requested !== 'number' || !Number.isSafeInteger(requested)) return 1;
  return Math.min(Math.max(requested, 1), pageCount);
}
