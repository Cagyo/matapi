import { Role } from './role';

export interface InviteCode {
  code: string;
  role: Role;
  createdBy: number | null;
  usedBy: number | null;
  createdAt: Date | null;
  usedAt: Date | null;
}

export interface NewInviteCode {
  code: string;
  role: Role;
  createdBy: number;
  createdAt: Date;
}
