import { Role } from './role';

export interface User {
  telegramId: number;
  name: string;
  role: Role;
  createdAt: Date | null;
}

export interface NewUser {
  telegramId: number;
  name: string;
  role: Role;
  createdAt: Date;
}
