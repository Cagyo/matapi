import type { ManifestPolicy } from "../../domain/signed-manifest";

export const UPDATE_MANIFEST_POLICY = Symbol("UPDATE_MANIFEST_POLICY");

export type UpdateManifestPolicy = ManifestPolicy;
