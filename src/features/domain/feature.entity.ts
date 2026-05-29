/** A feature toggle row (spec 17). Mirrors the `features` table. */
export interface Feature {
  name: string;
  enabled: boolean;
  installed: boolean;
  config: Record<string, unknown> | null;
}
