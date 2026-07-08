import { Role } from '../role';
import { NewUser, User } from '../user.entity';

export const USER_REPOSITORY = Symbol('USER_REPOSITORY');

export interface UserRepositoryPort {
  countAdmins(): Promise<number>;
  /**
   * Atomically create the first admin. Returns the created admin, or `null` if
   * an admin already exists. The count + insert run in one transaction so two
   * concurrent `/claim_admin` messages cannot both succeed (spec 11).
   */
  claimFirstAdmin(user: NewUser): Promise<User | null>;
  findByTelegramId(telegramId: number): Promise<User | null>;
  /** Case-insensitive name lookup; returns first match. Strips leading `@`. */
  findByName(name: string): Promise<User | null>;
  createAdmin(user: NewUser): Promise<User>;
  createUser(user: NewUser): Promise<User>;
  updateRole(telegramId: number, role: Role): Promise<User>;
  /** Toggle the user-level global mute (spec 12 — `/mute`, `/unmute`). */
  setMuted(telegramId: number, muted: boolean): Promise<User>;
  /**
   * Set or clear quiet-hours window (spec 12 — `/quiet_hours`). Pass `null`
   * for both fields to disable.
   */
  setQuietHours(
    telegramId: number,
    start: string | null,
    end: string | null,
  ): Promise<User>;
  /** All registered users — used by the notifier for fan-out. */
  listRecipients(): Promise<User[]>;
}
