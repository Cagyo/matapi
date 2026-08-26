/**
 * The authority that decides whether an actor may mutate a camera source.
 *
 * Every RTSP source mutation authorizes twice: once before the probe, and again
 * immediately before persistence. The second call is the final fence in front of
 * a synchronous better-sqlite3 transaction, so the port is synchronous by
 * contract — an implementation must read the current role without awaiting, and
 * without reusing an answer captured earlier in the request.
 *
 * Only the verdict crosses the boundary: a denial carries no actor identity.
 */
export const CAMERA_SOURCE_AUTHORIZATION = Symbol('CAMERA_SOURCE_AUTHORIZATION');

export interface CameraSourceAuthorizationPort {
  /** Synchronous better-sqlite3 role check used as the final mutation fence. */
  requireAdmin(userId: number): void;
}
