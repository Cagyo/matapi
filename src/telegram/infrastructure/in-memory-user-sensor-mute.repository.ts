import { UserSensorMuteRepositoryPort } from '../domain/ports/user-sensor-mute-repository.port';
import type { NotificationTargetRef } from '../domain/home-session';

export class InMemoryUserSensorMuteRepository
  implements UserSensorMuteRepositoryPort
{
  private readonly store = new Set<string>();

  private key(userId: number, target: NotificationTargetRef | string): string {
    return `${userId}:${this.targetKey(target)}`;
  }

  async isMuted(userId: number, target: NotificationTargetRef | string): Promise<boolean> {
    const key = this.key(userId, target);
    if (this.store.has(key)) return true;
    if (typeof target !== 'string' && target.kind === 'sensor') {
      const legacy = this.key(userId, target.id);
      if (!this.store.has(legacy)) return false;
      this.store.add(key);
      this.store.delete(legacy);
      return true;
    }
    return false;
  }

  async mute(userId: number, target: NotificationTargetRef | string): Promise<void> {
    this.store.add(this.key(userId, target));
  }

  async unmute(userId: number, target: NotificationTargetRef | string): Promise<void> {
    this.store.delete(this.key(userId, target));
    if (typeof target !== 'string' && target.kind === 'sensor') this.store.delete(this.key(userId, target.id));
  }

  async listForUser(userId: number): Promise<NotificationTargetRef[]> {
    const prefix = `${userId}:`;
    const values = [...this.store]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
    for (const value of values.filter((value) => !value.startsWith('sensor:') && !value.startsWith('camera:'))) {
      this.store.add(this.key(userId, { kind: 'sensor', id: value }));
      this.store.delete(this.key(userId, value));
    }
    return [...this.store]
      .filter((key) => key.startsWith(prefix))
      .map((key) => parseTarget(key.slice(prefix.length)))
      .filter((target): target is NotificationTargetRef => target !== null);
  }

  async countForUser(userId: number): Promise<number> {
    const prefix = `${userId}:`;
    let count = 0;
    for (const key of this.store) {
      if (key.startsWith(prefix)) count += 1;
    }
    return count;
  }

  private targetKey(target: NotificationTargetRef | string): string {
    return typeof target === 'string' ? target : `${target.kind}:${target.id}`;
  }
}

function parseTarget(value: string): NotificationTargetRef | null {
  const match = /^(sensor|camera):(.+)$/.exec(value);
  return match ? { kind: match[1] as NotificationTargetRef['kind'], id: match[2] } : null;
}
