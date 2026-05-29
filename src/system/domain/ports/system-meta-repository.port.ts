export const SYSTEM_META_REPOSITORY = Symbol('SYSTEM_META_REPOSITORY');

/** Key/value store backed by the `system_meta` table (spec 23 / spec 13). */
export interface SystemMetaRepositoryPort {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
