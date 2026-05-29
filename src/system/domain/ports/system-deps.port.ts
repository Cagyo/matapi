export const SYSTEM_DEPS = Symbol('SYSTEM_DEPS');

/**
 * Per-dependency comparison result (spec 18).
 *
 * `kind` drives the rendered diff line:
 *  - `upgrade`       — an apt/rclone upgrade is available (`current` → `available`).
 *  - `none`          — installed and up to date.
 *  - `not-installed` — package is absent on this host.
 *  - `node-minor`    — node minor/patch bump within the desired major (auto-applied).
 *  - `node-major`    — node major change vs desired; requires manual intervention.
 *  - `unknown`       — version could not be determined (e.g. apt unavailable on dev host).
 */
export type DepUpdateKind =
  | 'upgrade'
  | 'none'
  | 'not-installed'
  | 'node-minor'
  | 'node-major'
  | 'unknown';

export interface DepUpdate {
  name: string;
  current: string | null;
  available: string | null;
  kind: DepUpdateKind;
}

export interface SystemDepsCheck {
  /** All inspected dependencies, in display order. */
  deps: DepUpdate[];
  /** `true` when at least one auto-applicable upgrade is available. */
  hasUpdates: boolean;
  /** `true` when node's installed major differs from the desired major. */
  nodeMajorMismatch: boolean;
}

/**
 * OS-level dependency management for `/system_update` (spec 18 / spec 24).
 *
 * The adapter inspects apt packages, rclone and node, and delegates the
 * actual upgrade to `scripts/system-update.sh` (which owns the snapshot,
 * apt upgrade, rclone selfupdate, node minor bump, health check and the
 * curl-based failure notification).
 */
export interface SystemDepsPort {
  /**
   * Refresh package metadata and compute the installed-vs-available diff.
   * Never mutates the system. Fields degrade to `null`/`unknown` on hosts
   * without apt (e.g. macOS dev box).
   */
  check(): Promise<SystemDepsCheck>;
  /**
   * Spawn the detached `system-update.sh` script. Resolves once spawned;
   * the script pm2-restarts this process after its health check.
   */
  applyUpdate(): Promise<void>;
}
