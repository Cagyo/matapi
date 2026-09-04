import { describe, expect, it } from "vitest";

import {
  createLiveViewSettingsCandidate,
  createLiveViewSettingsDocument,
  nextLiveViewSettings,
  parsePrivateCameraCidr,
} from "../../../src/camera/domain/live-view-settings";
import { InvalidLiveViewCidrError } from "../../../src/camera/domain/errors/invalid-live-view-cidr.error";
import { LiveViewSettingsStateError } from "../../../src/camera/domain/errors/live-view-settings-state.error";

describe("parsePrivateCameraCidr", () => {
  it("canonicalizes private IPv4 CIDRs with host bits", () => {
    expect(parsePrivateCameraCidr(" 192.168.1.42/24 ")).toEqual({
      canonical: "192.168.1.0/24",
      normalizedHostBits: true,
    });
  });

  it("preserves canonical private IPv6 CIDRs", () => {
    expect(parsePrivateCameraCidr("fd12:3456::/48")).toEqual({
      canonical: "fd12:3456::/48",
      normalizedHostBits: false,
    });
  });

  it("rejects networks outside the explicit private allowlist", () => {
    expect(() => parsePrivateCameraCidr("8.8.8.0/24")).toThrow(
      InvalidLiveViewCidrError,
    );
    expect(() => parsePrivateCameraCidr("169.254.0.0/16")).toThrow(
      InvalidLiveViewCidrError,
    );
    expect(() => parsePrivateCameraCidr("fe80::/64")).toThrow(
      InvalidLiveViewCidrError,
    );
  });
});

describe("live-view settings validation", () => {
  it("removes duplicate networks and sorts IPv4, IPv6, prefix, then text", () => {
    expect(
      createLiveViewSettingsCandidate({
        enabled: true,
        allowedCameraCidrs: [
          "fd12::/64",
          "10.0.0.0/16",
          "192.168.1.42/24",
          "192.168.1.0/24",
          "10.0.0.0/8",
        ],
      }),
    ).toEqual({
      enabled: true,
      allowedCameraCidrs: [
        "10.0.0.0/8",
        "10.0.0.0/16",
        "192.168.1.0/24",
        "fd12::/64",
      ],
    });
  });

  it("rejects unknown keys and numeric boolean fields", () => {
    expect(() =>
      createLiveViewSettingsCandidate({
        enabled: 1,
        allowedCameraCidrs: [],
      }),
    ).toThrow(LiveViewSettingsStateError);
    expect(() =>
      createLiveViewSettingsDocument({
        version: 1,
        generation: 0,
        enabled: false,
        allowedCameraCidrs: [],
        extra: true,
      }),
    ).toThrow(LiveViewSettingsStateError);
  });

  it("requires a non-negative safe-integer generation", () => {
    expect(() =>
      createLiveViewSettingsDocument({
        version: 1,
        generation: 1.5,
        enabled: false,
        allowedCameraCidrs: [],
      }),
    ).toThrow(LiveViewSettingsStateError);
    expect(() =>
      createLiveViewSettingsDocument({
        version: 1,
        generation: -1,
        enabled: false,
        allowedCameraCidrs: [],
      }),
    ).toThrow(LiveViewSettingsStateError);
  });

  it("rejects more than sixteen distinct networks", () => {
    expect(() =>
      createLiveViewSettingsCandidate({
        enabled: false,
        allowedCameraCidrs: Array.from(
          { length: 17 },
          (_, index) => `10.${index}.0.0/16`,
        ),
      }),
    ).toThrow(LiveViewSettingsStateError);
  });

  it("increments the generation exactly once", () => {
    expect(
      nextLiveViewSettings(
        { version: 1, generation: 7, enabled: false, allowedCameraCidrs: [] },
        { enabled: true, allowedCameraCidrs: ["192.168.1.42/24"] },
      ),
    ).toEqual({
      version: 1,
      generation: 8,
      enabled: true,
      allowedCameraCidrs: ["192.168.1.0/24"],
    });
  });

  it("fails closed rather than overflowing the generation", () => {
    expect(() =>
      nextLiveViewSettings(
        {
          version: 1,
          generation: Number.MAX_SAFE_INTEGER,
          enabled: false,
          allowedCameraCidrs: [],
        },
        { enabled: true, allowedCameraCidrs: [] },
      ),
    ).toThrow(LiveViewSettingsStateError);
  });
});
