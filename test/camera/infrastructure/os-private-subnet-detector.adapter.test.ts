import type { NetworkInterfaceInfo } from "node:os";

import { describe, expect, it } from "vitest";

import { OsPrivateSubnetDetectorAdapter } from "../../../src/camera/infrastructure/os-private-subnet-detector.adapter";

type Interfaces = Record<string, readonly NetworkInterfaceInfo[] | undefined>;

function address(
  value: string,
  netmask: string,
  options: Partial<NetworkInterfaceInfo> = {},
): NetworkInterfaceInfo {
  const family = value.includes(":") ? "IPv6" : "IPv4";
  const prefix = family === "IPv4" ? 24 : 64;
  return {
    address: value,
    netmask,
    family,
    mac: "01:02:03:0a:0b:0c",
    internal: false,
    cidr: `${value}/${prefix}`,
    ...(family === "IPv6" ? { scopeid: 0 } : {}),
    ...options,
  } as NetworkInterfaceInfo;
}

describe("OsPrivateSubnetDetectorAdapter", () => {
  it("keeps eligible private networks only, canonicalizes them, and preserves bounded labels with their total", async () => {
    const interfaces: Interfaces = {
      lo: [address("127.0.0.1", "255.0.0.0", { internal: true })],
      malformed0: [address("192.168.50.1", "255.0.255.0", { cidr: null })],
      wlan0: [address("172.16.3.4", "255.255.0.0", { cidr: null })],
      wan0: [address("8.8.8.8", "255.255.255.0")],
      eth0: [address("192.168.1.42", "255.255.255.0")],
      br0: [address("192.168.1.1", "255.255.255.0")],
      lan0: [address("192.168.1.2", "255.255.255.0")],
      wlan1: [address("192.168.1.3", "255.255.255.0")],
      ula0: [address("fd12:3456::1", "ffff:ffff:ffff:ffff::")],
    };

    const suggestions = await new OsPrivateSubnetDetectorAdapter(
      () => interfaces,
    ).detect();

    expect(suggestions).toEqual([
      {
        cidr: "172.16.0.0/16",
        interfaceLabels: ["wlan0"],
        interfaceLabelCount: 1,
      },
      {
        cidr: "192.168.1.0/24",
        interfaceLabels: ["br0", "eth0", "lan0"],
        interfaceLabelCount: 4,
      },
      {
        cidr: "fd12:3456::/64",
        interfaceLabels: ["ula0"],
        interfaceLabelCount: 1,
      },
    ]);
  });

  it("keeps a stable first 32 canonical suggestions when virtual interfaces exceed the bound", async () => {
    const interfaces: Interfaces = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        `veth${index}`,
        [address(`10.0.${index}.42`, "255.255.255.0")],
      ]),
    );

    const suggestions = await new OsPrivateSubnetDetectorAdapter(
      () => interfaces,
    ).detect();

    expect(suggestions).toHaveLength(32);
    expect(suggestions[0]).toMatchObject({ cidr: "10.0.0.0/24" });
    expect(suggestions[31]).toMatchObject({ cidr: "10.0.31.0/24" });
  });
});
