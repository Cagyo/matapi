/** A configured camera (spec 20). Mirrors the `cameras` table row. */
export interface Camera {
  id: string;
  name: string;
  type: string;
  config: Record<string, unknown> | null;
  enabled: boolean;
}
