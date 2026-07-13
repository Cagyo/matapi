import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const reportPath = 'docs/compatibility/rtsp-runtime-spike.md';
const scriptPath = 'scripts/verify-rtsp-runtime.sh';

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

  it('fails a trial when the converter exits nonzero', () => {
    const script = readFileSync(scriptPath, 'utf8');

    expect(script).not.toContain('wait "$converter_pid" || true');
    expect(script).toMatch(/validate_converter_status/);
    expect(script).toContain("sh -c 'exit 23'");
    expect(script).toContain('reap_pid "$converter_probe_pid" converter_probe_status');
    expect(script).toMatch(/NEGATIVE_CONVERTER_STATUS PASS/);
  });

  it('enforces and proves a hard whole-trial deadline', () => {
    const script = readFileSync(scriptPath, 'utf8');

    expect(script).toMatch(/TRIAL_TIMEOUT_SECONDS=[1-9][0-9]*/);
    expect(script).toMatch(/NEGATIVE_TRIAL_DEADLINE PASS/);
    expect(script).toMatch(/trial deadline exceeded/);
  });

  it('handles process disappearance during deadline polling without diagnostics', () => {
    const script = readFileSync(scriptPath, 'utf8');

    expect(script).not.toContain('read -r _ _ state _ <"/proc/$pid/stat"');
    expect(script).toMatch(/awk '\{print \$3}' "\/proc\/\$pid\/stat" 2>\/dev\/null/);
  });

  it('bounds and proves the partial-JPEG buffer', () => {
    const script = readFileSync(scriptPath, 'utf8');

    expect(script).toMatch(/MAX_PARTIAL_JPEG_BYTES=[1-9][0-9]*/);
    expect(script).toContain('partial JPEG buffer limit exceeded');
    expect(script).toMatch(/NEGATIVE_PARTIAL_JPEG PASS/);
  });

  it('correlates configured UDP ports to converter-owned socket inodes', () => {
    const script = readFileSync(scriptPath, 'utf8');

    expect(script).toContain(`/proc/\${converter_pid}/fd`);
    expect(script).toContain('/proc/net/udp');
    expect(script).toMatch(/udp_ports=.*converter_udp_ports/);
    expect(script).toContain('udp_ports != "$UDP_MIN_PORT,$UDP_MAX_PORT"');
  });

  it('never infers fingerprint enforcement PASS from FFmpeg help text', () => {
    const script = readFileSync(scriptPath, 'utf8');

    expect(script).toContain(
      'TLS_FINGERPRINT_CAPABILITY DEFER no behavioral fingerprint fixture is available',
    );
    expect(script).not.toContain('TLS_FINGERPRINT_CAPABILITY PASS explicit fingerprint option present');
  });

  it('describes budget headroom without implying physical RAM availability', () => {
    const report = readFileSync(reportPath, 'utf8');

    expect(report).toMatch(/abstract 512 MiB process-budget headroom/i);
    expect(report).not.toMatch(/leaving approximately 413 MiB/);
  });
});
