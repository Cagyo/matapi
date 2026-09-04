import * as ipaddr from "ipaddr.js";

import { InvalidLiveViewCidrError } from "./errors/invalid-live-view-cidr.error";
import { LiveViewSettingsStateError } from "./errors/live-view-settings-state.error";

const MAX_ALLOWED_CAMERA_CIDRS = 16;

const PRIVATE_IPV4_CIDRS = [
  ipaddr.parseCIDR("10.0.0.0/8"),
  ipaddr.parseCIDR("172.16.0.0/12"),
  ipaddr.parseCIDR("192.168.0.0/16"),
] as const;
const PRIVATE_IPV6_CIDRS = [ipaddr.parseCIDR("fc00::/7")] as const;

export interface LiveViewSettingsCandidate {
  readonly enabled: boolean;
  readonly allowedCameraCidrs: readonly string[];
}

export interface LiveViewSettingsDocument extends LiveViewSettingsCandidate {
  readonly version: 1;
  readonly generation: number;
}

export interface ParsedPrivateCameraCidr {
  readonly canonical: string;
  readonly normalizedHostBits: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function isSafeGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isIpv4(value: ipaddr.IPv4 | ipaddr.IPv6): value is ipaddr.IPv4 {
  return value.kind() === "ipv4";
}

function isContainedByPrivateIpv4(
  address: ipaddr.IPv4,
  prefix: number,
): boolean {
  return PRIVATE_IPV4_CIDRS.some(
    ([network, networkPrefix]) =>
      prefix >= networkPrefix && address.match([network, networkPrefix]),
  );
}

function isContainedByPrivateIpv6(
  address: ipaddr.IPv6,
  prefix: number,
): boolean {
  return PRIVATE_IPV6_CIDRS.some(
    ([network, networkPrefix]) =>
      prefix >= networkPrefix && address.match([network, networkPrefix]),
  );
}

export function parsePrivateCameraCidr(raw: string): ParsedPrivateCameraCidr {
  if (typeof raw !== "string" || raw.trim().length === 0)
    throw new InvalidLiveViewCidrError();

  const input = raw.trim();
  let address: ipaddr.IPv4 | ipaddr.IPv6;
  let prefix: number;
  let networkAddress: ipaddr.IPv4 | ipaddr.IPv6;

  try {
    [address, prefix] = ipaddr.parseCIDR(input);
    networkAddress =
      address.kind() === "ipv4"
        ? ipaddr.IPv4.networkAddressFromCIDR(input)
        : ipaddr.IPv6.networkAddressFromCIDR(input);
  } catch {
    throw new InvalidLiveViewCidrError();
  }

  const privateNetwork = isIpv4(networkAddress)
    ? isContainedByPrivateIpv4(networkAddress, prefix)
    : isContainedByPrivateIpv6(networkAddress, prefix);
  if (!privateNetwork) throw new InvalidLiveViewCidrError();

  return {
    canonical: `${networkAddress.toString()}/${prefix}`,
    normalizedHostBits: address.toString() !== networkAddress.toString(),
  };
}

function canonicalizeCidrs(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === "string")
  ) {
    throw new LiveViewSettingsStateError();
  }

  const canonicalCidrs = [
    ...new Set(value.map((entry) => parsePrivateCameraCidr(entry).canonical)),
  ];
  if (canonicalCidrs.length > MAX_ALLOWED_CAMERA_CIDRS)
    throw new LiveViewSettingsStateError();

  return canonicalCidrs.sort((left, right) => {
    const [leftAddress, leftPrefix] = ipaddr.parseCIDR(left);
    const [rightAddress, rightPrefix] = ipaddr.parseCIDR(right);
    const family =
      leftAddress.kind() === rightAddress.kind()
        ? 0
        : leftAddress.kind() === "ipv4"
          ? -1
          : 1;
    if (family !== 0) return family;
    if (leftPrefix !== rightPrefix) return leftPrefix - rightPrefix;
    return left.localeCompare(right);
  });
}

export function createLiveViewSettingsCandidate(
  value: unknown,
): LiveViewSettingsCandidate {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["enabled", "allowedCameraCidrs"]) ||
    typeof value.enabled !== "boolean"
  ) {
    throw new LiveViewSettingsStateError();
  }

  return {
    enabled: value.enabled,
    allowedCameraCidrs: canonicalizeCidrs(value.allowedCameraCidrs),
  };
}

export function createLiveViewSettingsDocument(
  value: unknown,
): LiveViewSettingsDocument {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "version",
      "generation",
      "enabled",
      "allowedCameraCidrs",
    ]) ||
    value.version !== 1 ||
    !isSafeGeneration(value.generation)
  ) {
    throw new LiveViewSettingsStateError();
  }

  const candidate = createLiveViewSettingsCandidate({
    enabled: value.enabled,
    allowedCameraCidrs: value.allowedCameraCidrs,
  });
  return { version: 1, generation: value.generation, ...candidate };
}

export function nextLiveViewSettings(
  current: LiveViewSettingsDocument,
  candidate: LiveViewSettingsCandidate,
): LiveViewSettingsDocument {
  const committed = createLiveViewSettingsDocument(current);
  const normalizedCandidate = createLiveViewSettingsCandidate(candidate);
  if (committed.generation === Number.MAX_SAFE_INTEGER)
    throw new LiveViewSettingsStateError();

  return {
    version: 1,
    generation: committed.generation + 1,
    ...normalizedCandidate,
  };
}
