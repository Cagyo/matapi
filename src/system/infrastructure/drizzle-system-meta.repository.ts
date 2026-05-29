import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { AppDatabase, DB } from '../../database/database.module';
import { systemMeta } from '../../database/schema';
import { SystemMetaRepositoryPort } from '../domain/ports/system-meta-repository.port';

@Injectable()
export class DrizzleSystemMetaRepository implements SystemMetaRepositoryPort {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  async get(key: string): Promise<string | null> {
    const row = this.db
      .select({ value: systemMeta.value })
      .from(systemMeta)
      .where(eq(systemMeta.key, key))
      .get();
    return row?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.db
      .insert(systemMeta)
      .values({ key, value })
      .onConflictDoUpdate({ target: systemMeta.key, set: { value } })
      .run();
  }

  async delete(key: string): Promise<void> {
    this.db.delete(systemMeta).where(eq(systemMeta.key, key)).run();
  }
}
