import { describe, expect, it } from 'vitest';
import { parseMhZ19Frame } from '../../../src/sensors/infrastructure/uart-co2.adapter';

/**
 * The real `UartCo2Adapter` opens a `serialport` device and is exercised on
 * the Pi manually. Here we cover the pure protocol parser only — every other
 * code path (buffering, threshold, flush) is covered by the mock adapter test
 * via the shared `BaseUartCo2Adapter`.
 */
describe('parseMhZ19Frame', () => {
  it('decodes a valid frame to ppm', () => {
    // 620 ppm = 0x026C → high=0x02, low=0x6C
    const high = 0x02;
    const low = 0x6c;
    const frame = buildFrame(high, low);
    expect(parseMhZ19Frame(frame)).toBe(620);
  });

  it('rejects a frame with a bad checksum', () => {
    const frame = buildFrame(0x02, 0x6c);
    frame[8] = frame[8] ^ 0xff;
    expect(parseMhZ19Frame(frame)).toBeNull();
  });

  it('rejects a frame of wrong length', () => {
    expect(parseMhZ19Frame(new Uint8Array(8))).toBeNull();
  });

  it('rejects a frame with wrong header bytes', () => {
    const frame = buildFrame(0x02, 0x6c);
    frame[0] = 0xaa;
    expect(parseMhZ19Frame(frame)).toBeNull();
  });
});

function buildFrame(high: number, low: number): Uint8Array {
  const f = new Uint8Array([0xff, 0x86, high, low, 0x00, 0x00, 0x00, 0x00, 0x00]);
  let sum = 0;
  for (let i = 1; i < 8; i += 1) sum += f[i];
  f[8] = ((~sum + 1) & 0xff) >>> 0;
  return f;
}
