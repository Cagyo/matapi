import { describe, expect, it } from 'vitest';
import { InvalidLiveSourceError } from '../../../src/camera/domain/errors/invalid-live-source.error';
import { StreamEgressGrant } from '../../../src/camera/domain/stream-egress-grant.value-object';

const NOW = 1_800_000_000_000;

function validInput() {
  return {
    sessionId: '123e4567-e89b-42d3-a456-426614174000',
    nonceHash: 'ab'.repeat(32),
    addresses: ['192.0.2.10'] as readonly string[],
    rtspControlPorts: [554] as readonly number[],
    transport: 'tcp' as const,
    expiresAtUnixMs: NOW + 30_000,
  };
}

describe('StreamEgressGrant', () => {
  it('creates an immutable grant from bounded validated values', () => {
    const grant = StreamEgressGrant.create(validInput(), NOW);

    expect(grant).toMatchObject({
      sessionId: validInput().sessionId,
      nonceHash: validInput().nonceHash,
      addresses: [{ family: 'ipv4', address: '192.0.2.10' }],
      rtspControlPorts: [554],
      transport: { kind: 'tcp' },
      expiresAtUnixMs: NOW + 30_000,
    });
    expect(Object.isFrozen(grant)).toBe(true);
    expect(Object.isFrozen(grant.addresses[0])).toBe(true);
    expect(grant.isValidated()).toBe(true);
  });

  it('accepts two unique literal addresses and a bounded UDP range', () => {
    const grant = StreamEgressGrant.create(
      {
        ...validInput(),
        addresses: ['192.0.2.10', '2001:db8::10'],
        transport: 'udp',
        udpMediaPorts: { first: 24_000, last: 24_001 },
      },
      NOW,
    );

    expect(grant.addresses).toEqual([
      { family: 'ipv4', address: '192.0.2.10' },
      { family: 'ipv6', address: '2001:db8::10' },
    ]);
    expect(grant.transport).toEqual({
      kind: 'udp',
      udpMediaPorts: { first: 24_000, last: 24_001 },
    });
  });

  it.each([
    [{ sessionId: 's1' }, 'session UUID'],
    [{ sessionId: null as never }, 'session runtime type'],
    [{ nonceHash: 'ab' }, 'nonce hash length'],
    [{ nonceHash: 'z'.repeat(64) }, 'nonce hash hex'],
    [{ nonceHash: null as never }, 'nonce runtime type'],
    [{ addresses: [] }, 'missing address'],
    [{ addresses: ['192.0.2.1', '192.0.2.2', '192.0.2.3'] }, 'address bound'],
    [{ addresses: ['camera.local'] }, 'non-literal address'],
    [{ addresses: [42 as never] }, 'address runtime type'],
    [{ addresses: ['192.0.2.1', '192.0.2.1'] }, 'duplicate address'],
    [
      { addresses: ['2001:db8::1', '2001:0db8:0:0:0:0:0:1'] },
      'equivalent duplicate IPv6 address',
    ],
    [{ addresses: null as never }, 'addresses runtime type'],
    [{ rtspControlPorts: [] }, 'missing control port'],
    [{ rtspControlPorts: [554, 554] }, 'duplicate control port'],
    [{ rtspControlPorts: [554, 8554, 9554] }, 'control port count'],
    [{ rtspControlPorts: [0] }, 'low control port'],
    [{ rtspControlPorts: [65_536] }, 'high control port'],
    [{ rtspControlPorts: [1.5] }, 'fractional control port'],
    [{ rtspControlPorts: null as never }, 'ports runtime type'],
    [{ expiresAtUnixMs: Number.NaN }, 'NaN expiry'],
    [{ expiresAtUnixMs: Number.POSITIVE_INFINITY }, 'infinite expiry'],
    [{ expiresAtUnixMs: NOW }, 'expired lease'],
    [{ expiresAtUnixMs: NOW + 300_001 }, 'overlong lease'],
    [{ expiresAtUnixMs: NOW + 1.5 }, 'fractional expiry'],
  ])('rejects invalid %s (%s)', (override) => {
    expect(() =>
      StreamEgressGrant.create({ ...validInput(), ...override }, NOW),
    ).toThrow(InvalidLiveSourceError);
  });

  it.each([
    [{ first: 0, last: 2 }, 'low'],
    [{ first: 24_001, last: 24_000 }, 'unordered'],
    [{ first: 65_535, last: 65_536 }, 'high'],
    [{ first: 24_000.5, last: 24_001 }, 'fractional'],
    [{ first: 24_000, last: 24_064 }, 'too wide'],
  ])('rejects an invalid UDP range (%s: %s)', (udpMediaPorts) => {
    expect(() =>
      StreamEgressGrant.create(
        {
          ...validInput(),
          transport: 'udp',
          udpMediaPorts,
        },
        NOW,
      ),
    ).toThrow(InvalidLiveSourceError);
  });

  it('rejects malformed runtime transport without throwing TypeError', () => {
    expect(() =>
      StreamEgressGrant.create(
        { ...validInput(), transport: 'icmp' as never },
        NOW,
      ),
    ).toThrow(InvalidLiveSourceError);
  });

  it.each([Number.NaN, 1.5, null as never])(
    'rejects malformed current time %s without throwing TypeError',
    (nowUnixMs) => {
      expect(() => StreamEgressGrant.create(validInput(), nowUnixMs)).toThrow(
        InvalidLiveSourceError,
      );
    },
  );

  it('rejects a malformed whole request without throwing TypeError', () => {
    expect(() => StreamEgressGrant.create(null as never, NOW)).toThrow(
      InvalidLiveSourceError,
    );
  });

  it('rejects a negative current Unix epoch even when expiry is future', () => {
    expect(() =>
      StreamEgressGrant.create(
        { ...validInput(), expiresAtUnixMs: 1 },
        -1,
      ),
    ).toThrow(InvalidLiveSourceError);
  });

  it('rejects a negative expiry with a nonnegative current time', () => {
    expect(() =>
      StreamEgressGrant.create(
        { ...validInput(), expiresAtUnixMs: -1 },
        0,
      ),
    ).toThrow(InvalidLiveSourceError);
  });
});
