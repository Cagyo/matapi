import { Injectable } from '@nestjs/common';

@Injectable()
export class WorkflowOperationQueue {
  private readonly operations = new Map<string, Promise<void>>();

  async run<T>(
    userId: number,
    chatId: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = `${userId}:${chatId}`;
    const predecessor = this.operations.get(key) ?? Promise.resolve();
    let release!: () => void;
    const active = new Promise<void>((resolve) => { release = resolve; });
    const tail = predecessor.then(() => active);
    this.operations.set(key, tail);

    await predecessor;
    try {
      return await operation();
    } finally {
      release();
      if (this.operations.get(key) === tail) this.operations.delete(key);
    }
  }
}
