import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function scenario(name: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(execFileSync('python3', [
    resolve('test/scripts/live_stream_runner_harness.py'),
    resolve('scripts/live-stream-ffmpeg-runner'),
    name,
  ], { encoding: 'utf8' }));
  if (typeof parsed !== 'object' || parsed === null) throw new Error('invalid harness output');
  return parsed as Record<string, unknown>;
}

describe('live-stream FFmpeg runner', () => {
  it('unlinks the credential file and keeps injection text in one fixed argv element', () => {
    const result = scenario('valid');
    expect(result).toMatchObject({ ok: true, configRemoved: true, shellPresent: false });
    expect(result.argvContainsSecret).toBe(false);
    expect(result.inputArg).toMatch(/^\/proc\/self\/fd\/\d+$/u);
    expect(result.concat).toContain("it'\\''s-one-arg-$(reboot);still-one-arg");
    expect(result.output).toMatch(/^unix:\/\//u);
  });

  it.each(['unknown', 'wrong-output', 'duplicate'])('rejects %s config without exposing it', (name) => {
    expect(scenario(name)).toMatchObject({ ok: false });
  });

  it('rejects a hostname runtime URL so the restricted identity never needs DNS', () => {
    expect(scenario('hostname')).toMatchObject({ ok: false });
  });

  it('keeps strict TLS identity and the validated custom CA in the private concat input', () => {
    const result = scenario('strict-ca');
    expect(result).toMatchObject({ ok: true, argvContainsSecret: false });
    expect(result.concat).toContain("option verifyhost 'camera.local'");
    expect(result.concat).toMatch(/option ca_file '\/tmp\/[^']+\/ca\/camera\.pem'/u);
  });
});
