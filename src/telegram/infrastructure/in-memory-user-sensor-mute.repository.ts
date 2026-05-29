import { UserSensorMuteRepositoryPort } from '../domain/ports/user-sensor-mute-repository.port';

export class InMemoryUserSensorMuteRepository
  implements UserSensorMuteRepositoryPort
{
  private readonly store = new Set<string>();

  private key(userId: number, sensorId: string): string {
    return `${userId}:${sensorId}`;
  }

  async isMuted(userId: number, sensorId: string): Promise<boolean> {
    return this.store.has(this.key(userId, sensorId));
  }

  async mute(userId: number, sensorId: string): Promise<void> {
    this.store.add(this.key(userId, sensorId));
  }

  async unmute(userId: number, sensorId: string): Promise<void> {
    this.store.delete(this.key(userId, sensorId));
  }

  async listForUser(userId: number): Promise<string[]> {
    const prefix = `${userId}:`;
    return [...this.store]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
  }
}
