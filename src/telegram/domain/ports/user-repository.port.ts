import { Role } from '../role';
import { NewUser, User } from '../user.entity';

export const USER_REPOSITORY = Symbol('USER_REPOSITORY');

export interface UserRepositoryPort {
  countAdmins(): Promise<number>;
  findByTelegramId(telegramId: number): Promise<User | null>;
  /** Case-insensitive name lookup; returns first match. Strips leading `@`. */
  findByName(name: string): Promise<User | null>;
  createAdmin(user: NewUser): Promise<User>;
  createUser(user: NewUser): Promise<User>;
  updateRole(telegramId: number, role: Role): Promise<User>;
  /** All registered users — used by the notifier for fan-out. */
  listRecipients(): Promise<User[]>;
}
