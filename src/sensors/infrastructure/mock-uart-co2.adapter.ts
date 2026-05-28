import { Injectable } from '@nestjs/common';
import {
  BaseUartCo2Adapter,
  Co2Source,
  UartCo2Config,
  UartCo2Defaults,
} from './base-uart-co2.adapter';
import {
  SensorLogRepositoryPort,
} from '../domain/ports/sensor-log-repository.port';

/**
 * In-memory CO2 source for development. By default cycles through a benign
 * sequence so that the dev panel sees movement; tests inject their own
 * sequence or call `pushReading()` directly.
 */
export class InMemoryCo2Source implements Co2Source {
  private opened = false;
  private sequence: number[];
  private cursor = 0;
  private failures = 0;

  constructor(sequence: number[] = [620, 650, 700, 820, 950, 1100, 1300, 900, 700]) {
    this.sequence = [...sequence];
  }

  async open(_uart: UartCo2Config): Promise<void> {
    this.opened = true;
  }
  async close(): Promise<void> {
    this.opened = false;
  }
  isOpen(): boolean {
    return this.opened;
  }

  async read(): Promise<number | null> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('simulated read failure');
    }
    if (this.sequence.length === 0) return null;
    const ppm = this.sequence[this.cursor % this.sequence.length];
    this.cursor += 1;
    return ppm;
  }

  /** Replace the cycling sequence (e.g. dev panel slider). */
  setSequence(values: number[]): void {
    this.sequence = values.length > 0 ? [...values] : [0];
    this.cursor = 0;
  }

  /** Queue N consecutive failed reads (degraded-state test helper). */
  queueFailures(count: number): void {
    this.failures = count;
  }
}

@Injectable()
export class MockUartCo2Adapter extends BaseUartCo2Adapter {
  constructor(logs: SensorLogRepositoryPort, source: InMemoryCo2Source = new InMemoryCo2Source()) {
    super(source, logs, MockUartCo2Adapter.name);
  }

  protected defaults(): UartCo2Defaults {
    return {
      warning: 800,
      critical: 1200,
      readIntervalMs: 5000,
      flushIntervalMs: 60000,
      baudRate: 9600,
    };
  }

  /** Access to the underlying in-memory source (dev panel hook). */
  get inMemorySource(): InMemoryCo2Source {
    return this.source as InMemoryCo2Source;
  }
}
