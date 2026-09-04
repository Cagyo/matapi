import { readFileSync } from "node:fs";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

import * as ipaddr from "ipaddr.js";

import { parsePrivateCameraCidr } from "../domain/live-view-settings";
import type {
  PrivateSubnetDetectorPort,
  PrivateSubnetSuggestion,
} from "../domain/ports/private-subnet-detector.port";

const MAX_SUGGESTIONS = 32;
const MAX_INTERFACE_LABELS = 3;

type DetectedSubnet = Omit<PrivateSubnetSuggestion, "selector">;
type NetworkInterfaces = ReturnType<typeof networkInterfaces>;
type InterfaceStateReader = (interfaceLabel: string) => string;

export class OsPrivateSubnetDetectorAdapter
  implements PrivateSubnetDetectorPort
{
  constructor(
    private readonly readNetworkInterfaces: () => NetworkInterfaces =
      networkInterfaces,
    private readonly readInterfaceState: InterfaceStateReader =
      readLinuxInterfaceState,
  ) {}

  async detect(): Promise<readonly DetectedSubnet[]> {
    const labelsByCidr = new Map<string, Set<string>>();

    for (const [label, entries] of Object.entries(
      this.readNetworkInterfaces(),
    )) {
      if (!entries || !isUsableInterface(label, this.readInterfaceState)) {
        continue;
      }
      for (const entry of entries) {
        const cidr = privateCidr(entry);
        if (!cidr) continue;

        const labels = labelsByCidr.get(cidr) ?? new Set<string>();
        labels.add(label);
        labelsByCidr.set(cidr, labels);
      }
    }

    return [...labelsByCidr]
      .map(([cidr, labels]) => suggestionFor(cidr, labels))
      .sort(compareSuggestions)
      .slice(0, MAX_SUGGESTIONS);
  }
}

function privateCidr(entry: NetworkInterfaceInfo): string | null {
  if (entry.internal) return null;

  // Node reports `cidr: null` when its netmask metadata is unusable. There is
  // no independent prefix source in this API, so a suggestion must fail closed.
  if (entry.cidr === null) return null;

  const prefix = prefixFromCidr(entry.cidr, entry.family);
  if (prefix === null) return null;

  try {
    return parsePrivateCameraCidr(`${entry.address}/${prefix}`).canonical;
  } catch {
    return null;
  }
}

function suggestionFor(cidr: string, labels: ReadonlySet<string>): DetectedSubnet {
  const sortedLabels = [...labels].sort((left, right) =>
    left.localeCompare(right),
  );
  return {
    cidr,
    interfaceLabels: sortedLabels.slice(0, MAX_INTERFACE_LABELS),
    interfaceLabelCount: sortedLabels.length,
  };
}

function prefixFromCidr(
  cidr: string,
  family: NetworkInterfaceInfo["family"],
): number | null {
  try {
    const [address, prefix] = ipaddr.parseCIDR(cidr);
    if (
      (family === "IPv4" && address.kind() !== "ipv4") ||
      (family === "IPv6" && address.kind() !== "ipv6")
    ) {
      return null;
    }
    return prefix;
  } catch {
    return null;
  }
}

function isUsableInterface(
  label: string,
  readState: InterfaceStateReader,
): boolean {
  if (!isSafeInterfaceLabel(label)) return false;
  try {
    const state = readState(label).trim();
    return state === "up" || state === "unknown";
  } catch {
    return false;
  }
}

function isSafeInterfaceLabel(label: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,14}$/.test(label);
}

function readLinuxInterfaceState(interfaceLabel: string): string {
  return readFileSync(
    `/sys/class/net/${interfaceLabel}/operstate`,
    "utf8",
  ).trim();
}

function compareSuggestions(left: DetectedSubnet, right: DetectedSubnet): number {
  const [leftAddress, leftPrefix] = ipaddr.parseCIDR(left.cidr);
  const [rightAddress, rightPrefix] = ipaddr.parseCIDR(right.cidr);
  if (leftAddress.kind() !== rightAddress.kind()) {
    return leftAddress.kind() === "ipv4" ? -1 : 1;
  }
  if (leftPrefix !== rightPrefix) return leftPrefix - rightPrefix;

  const leftBytes = leftAddress.toByteArray();
  const rightBytes = rightAddress.toByteArray();
  for (let index = 0; index < leftBytes.length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      return leftBytes[index] - rightBytes[index];
    }
  }
  return left.interfaceLabels.join("\u0000").localeCompare(
    right.interfaceLabels.join("\u0000"),
  );
}
