import { Role } from './role';

export interface User {
  telegramId: number;
  name: string;
  role: Role;
  muted: boolean;
  /** Quiet-hours start (`HH:MM`, 24h, local TZ) or `null` when disabled. */
  quietStart: string | null;
  /** Quiet-hours end (`HH:MM`, 24h, local TZ) or `null` when disabled. */
  quietEnd: string | null;
  createdAt: Date | null;
}

export interface NewUser {
  telegramId: number;
  name: string;
  role: Role;
  createdAt: Date;
}
