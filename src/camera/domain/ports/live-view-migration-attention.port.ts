export const LIVE_VIEW_MIGRATION_ATTENTION = Symbol(
  "LIVE_VIEW_MIGRATION_ATTENTION",
);

export type LiveViewMigrationAttention = "legacy-values-invalid";

export interface LiveViewMigrationAttentionPort {
  read(): Promise<LiveViewMigrationAttention | null>;
}
