import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const reportPath = 'docs/compatibility/rtsp-runtime-spike.md';

describe('RTSP runtime spike decision record', () => {
  it('requires the spike report to name one bounded FFmpeg-to-gateway transport', () => {
    const report = readFileSync(reportPath, 'utf8');

    expect(report).toMatch(/Selected data plane: (FIFO|loopback HTTP|Unix socket)/);
    expect(report).toMatch(/Backpressure limit: [1-9][0-9]* frames/);
  });

  it('requires a pass or explicit defer result for self-signed fingerprint enforcement', () => {
    const report = readFileSync(reportPath, 'utf8');

    expect(report).toMatch(/Self-signed fingerprint enforcement: (PASS|DEFER)/);
  });
});
