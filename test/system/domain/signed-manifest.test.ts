import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  classifyStableRelease,
  parseOuterEnvelope,
  verifySignedEnvelope,
  type ActiveKey,
  type ManifestPolicy,
} from "../../../src/system/domain/signed-manifest";

const CHECK_TIME = new Date("2030-01-15T00:00:00.000Z");
const SHA256 = "a".repeat(64);

const policy: ManifestPolicy = {
  feedUrl:
    "https://updates.example.test/home-worker/stable/update-envelope.json",
  channel: "stable",
  target: {
    targetName: "linux-armv7-glibc",
    platform: "linux",
    arch: "arm",
    libc: "glibc",
    libcVersion: "2.36",
    nodeModulesAbi: "115",
  },
  runtime: { nodeMajor: 20, packageManager: "yarn@4.13.0" },
  limits: {
    maxArtifactBytes: 100 * 1024 * 1024,
    maxExpandedBytes: 512 * 1024 * 1024,
    maxPreparedBytes: 512 * 1024 * 1024,
    maxPreparedFiles: 20_000,
    maxFiles: 20_000,
  },
};

function validManifest(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    metadataVersion: 42,
    channel: "stable",
    version: "1.4.2",
    commit: "0123456789abcdef0123456789abcdef01234567",
    publishedAt: "2030-01-01T00:00:00.000Z",
    expiresAt: "2030-01-31T00:00:00.000Z",
    target: {
      platform: "linux",
      arch: "arm",
      libc: "glibc",
      libcMinVersion: "2.28",
      nodeModulesAbi: "115",
    },
    artifact: {
      url: "https://updates.example.test/home-worker/releases/home-worker-1.4.2.tar.gz",
      format: "tar.gz",
      size: 50 * 1024 * 1024,
      expandedSize: 200 * 1024 * 1024,
      maxPreparedSize: 300 * 1024 * 1024,
      maxPreparedFiles: 10_000,
      fileCount: 8_500,
      sha256: SHA256,
    },
    runtime: { nodeMajor: 20, packageManager: "yarn@4.13.0" },
  };
}

function keyId(publicKey: KeyObject): string {
  return createHash("sha256")
    .update(publicKey.export({ format: "der", type: "spki" }))
    .digest("hex");
}

function activeKey(publicKey: KeyObject): ActiveKey {
  return { keyId: keyId(publicKey), publicKey };
}

function envelopeBytes(
  payload: Buffer,
  signatures: { keyId: string; signature: Buffer }[],
): Buffer {
  return Buffer.from(
    JSON.stringify({
      payload: payload.toString("base64"),
      signatures: signatures.map((entry) => ({
        keyId: entry.keyId,
        signature: entry.signature.toString("base64"),
      })),
    }),
  );
}

function signed(
  manifest = validManifest(),
  keys = [generateKeyPairSync("ed25519")],
): { bytes: Buffer; payload: Buffer; keys: ActiveKey[] } {
  const payload = Buffer.from(JSON.stringify(manifest));
  return {
    bytes: envelopeBytes(
      payload,
      keys.map(({ publicKey, privateKey }) => ({
        keyId: keyId(publicKey),
        signature: sign(null, payload, privateKey),
      })),
    ),
    payload,
    keys: keys.map(({ publicKey }) => activeKey(publicKey)),
  };
}

function mutate(
  source: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const copy = structuredClone(source);
  const parts = path.split(".");
  let current = copy;
  for (const part of parts.slice(0, -1))
    current = current[part] as Record<string, unknown>;
  current[parts.at(-1)!] = value;
  return copy;
}

describe("signed OTA envelope", () => {
  it.each([
    ["duplicate key", '{"payload":"e30=","payload":"e30=","signatures":[]}'],
    ["unknown key", '{"payload":"e30=","signatures":[],"extra":1}'],
    ["unpadded base64", '{"payload":"e30","signatures":[]}'],
  ])("rejects %s", (_name, json) => {
    expect(() => parseOuterEnvelope(Buffer.from(json))).toThrow();
  });

  it("rejects envelopes over 96 KiB before parsing", () => {
    expect(() => parseOuterEnvelope(Buffer.alloc(96 * 1024 + 1, 0x20))).toThrow(
      /96 KiB/i,
    );
  });

  it.each([0, 4])("rejects %i signatures", (count) => {
    const payload = Buffer.from("{}");
    const signatures = Array.from({ length: count }, (_, index) => ({
      keyId: index.toString(16).padStart(64, "0"),
      signature: Buffer.alloc(64),
    }));
    expect(() =>
      parseOuterEnvelope(envelopeBytes(payload, signatures)),
    ).toThrow(/signature/i);
  });

  it("rejects duplicate key IDs and signatures that are not 64 bytes", () => {
    const entry = { keyId: "a".repeat(64), signature: Buffer.alloc(64) };
    expect(() =>
      parseOuterEnvelope(envelopeBytes(Buffer.from("{}"), [entry, entry])),
    ).toThrow(/duplicate/i);
    expect(() =>
      parseOuterEnvelope(
        envelopeBytes(Buffer.from("{}"), [
          { ...entry, signature: Buffer.alloc(63) },
        ]),
      ),
    ).toThrow(/64 bytes/i);
  });

  it("accepts Ed25519 signatures and rejects one changed payload byte", () => {
    const pair = generateKeyPairSync("ed25519");
    const payload = Buffer.from(JSON.stringify(validManifest()));
    const signature = sign(null, payload, pair.privateKey);
    const key = activeKey(pair.publicKey);

    expect(
      verifySignedEnvelope(
        envelopeBytes(payload, [{ keyId: key.keyId, signature }]),
        [key],
        policy,
        CHECK_TIME,
      ),
    ).toBeTruthy();
    payload[0] ^= 1;
    expect(() =>
      verifySignedEnvelope(
        envelopeBytes(payload, [{ keyId: key.keyId, signature }]),
        [key],
        policy,
        CHECK_TIME,
      ),
    ).toThrow(/signature/i);
  });

  it("requires at least one recognized active signature and returns every matching key ID", () => {
    const first = generateKeyPairSync("ed25519");
    const second = generateKeyPairSync("ed25519");
    const release = signed(validManifest(), [first, second]);
    const verified = verifySignedEnvelope(
      release.bytes,
      release.keys,
      policy,
      CHECK_TIME,
    );

    expect(verified.outerBytes).toEqual(release.bytes);
    expect(verified.payloadBytes).toEqual(release.payload);
    expect(verified.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(verified.matchingActiveKeyIds).toEqual(
      release.keys.map((key) => key.keyId),
    );

    const unknown = generateKeyPairSync("ed25519");
    expect(() =>
      verifySignedEnvelope(
        release.bytes,
        [activeKey(unknown.publicKey)],
        policy,
        CHECK_TIME,
      ),
    ).toThrow(/signature/i);
  });

  it("permits unknown signature key IDs when one active signature verifies", () => {
    const active = generateKeyPairSync("ed25519");
    const unknown = generateKeyPairSync("ed25519");
    const release = signed(validManifest(), [active, unknown]);

    const verified = verifySignedEnvelope(
      release.bytes,
      [release.keys[0]],
      policy,
      CHECK_TIME,
    );

    expect(verified.matchingActiveKeyIds).toEqual([release.keys[0].keyId]);
  });

  it("recomputes active key IDs from DER SPKI before verification", () => {
    const release = signed();
    expect(() =>
      verifySignedEnvelope(
        release.bytes,
        [{ ...release.keys[0], keyId: "f".repeat(64) }],
        policy,
        CHECK_TIME,
      ),
    ).toThrow(/signature/i);
  });

  it("returns byte buffers that do not alias caller-owned envelope bytes", () => {
    const release = signed();
    const input = Buffer.from(release.bytes);
    const verified = verifySignedEnvelope(
      input,
      release.keys,
      policy,
      CHECK_TIME,
    );
    input[0] ^= 1;

    expect(verified.outerBytes).toEqual(release.bytes);
    expect(verified.outerBytes).not.toBe(input);
    expect(verified.payloadBytes).toEqual(release.payload);
  });

  it.each(["e3-=", "e30===", "e3 0="])(
    "rejects malformed envelope Base64 %s",
    (payload) => {
      expect(() =>
        parseOuterEnvelope(
          Buffer.from(
            JSON.stringify({
              payload,
              signatures: [
                {
                  keyId: "a".repeat(64),
                  signature: Buffer.alloc(64).toString("base64"),
                },
              ],
            }),
          ),
        ),
      ).toThrow(/Base64/i);
    },
  );

  it("rejects decoded manifests over 64 KiB, fatal UTF-8, and BOM", () => {
    const pair = generateKeyPairSync("ed25519");
    const key = activeKey(pair.publicKey);
    for (const payload of [
      Buffer.alloc(64 * 1024 + 1, 0x20),
      Buffer.from([0xc3, 0x28]),
      Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]),
    ]) {
      const signature = sign(null, payload, pair.privateKey);
      expect(() =>
        verifySignedEnvelope(
          envelopeBytes(payload, [{ keyId: key.keyId, signature }]),
          [key],
          policy,
          CHECK_TIME,
        ),
      ).toThrow();
    }
  });
});

describe("signed manifest validation", () => {
  it("maps a valid manifest to a checked release identity", () => {
    const release = signed();
    const verified = verifySignedEnvelope(
      release.bytes,
      release.keys,
      policy,
      CHECK_TIME,
    );

    expect(verified.manifest.version).toBe("1.4.2");
    expect(verified.checkedRelease.artifact.targetName).toBe(
      "linux-armv7-glibc",
    );
    expect(verified.checkedRelease.artifact.target.libcMinVersion).toBe("2.28");
    expect(verified.checkedRelease.metadata).toMatchObject({
      metadataVersion: 42,
      channel: "stable",
      payloadSha256: verified.payloadSha256,
    });
  });

  it.each(["1.0000000000000001", "9007199254740991.1"])(
    "rejects exact non-integer metadataVersion lexeme %s before Number rounding",
    (lexeme) => {
      const pair = generateKeyPairSync("ed25519");
      const payload = Buffer.from(
        JSON.stringify(validManifest()).replace(
          '"metadataVersion":42',
          `"metadataVersion":${lexeme}`,
        ),
      );
      const key = activeKey(pair.publicKey);
      const bytes = envelopeBytes(payload, [
        {
          keyId: key.keyId,
          signature: sign(null, payload, pair.privateKey),
        },
      ]);

      expect(() =>
        verifySignedEnvelope(bytes, [key], policy, CHECK_TIME),
      ).toThrow(/integer/i);
    },
  );

  it.each([
    ["unknown top-level key", "extra", 1],
    ["unknown schema", "schemaVersion", 2],
    ["unsafe metadata version", "metadataVersion", Number.MAX_SAFE_INTEGER + 1],
    ["zero metadata version", "metadataVersion", 0],
    ["build metadata", "version", "1.4.2+build.1"],
    ["prerelease", "version", "1.4.2-rc.1"],
    ["leading-zero SemVer", "version", "01.4.2"],
    ["short commit", "commit", "abc123"],
    ["non-canonical timestamp", "publishedAt", "2030-01-01T00:00:00Z"],
    ["expired", "expiresAt", "2030-01-14T23:59:59.999Z"],
    ["future published time", "publishedAt", "2030-01-15T00:05:00.001Z"],
    ["validity over 31 days", "expiresAt", "2030-02-01T00:00:00.001Z"],
    [
      "URL credentials",
      "artifact.url",
      "https://user:pass@updates.example.test/file.tar.gz",
    ],
    [
      "URL fragment",
      "artifact.url",
      "https://updates.example.test/file.tar.gz#part",
    ],
    ["HTTP URL", "artifact.url", "http://updates.example.test/file.tar.gz"],
    [
      "cross-origin URL",
      "artifact.url",
      "https://evil.example.test/file.tar.gz",
    ],
    ["artifact format", "artifact.format", "zip"],
    ["target platform", "target.platform", "darwin"],
    ["target arch", "target.arch", "arm64"],
    ["target libc", "target.libc", "musl"],
    ["malformed libc", "target.libcMinVersion", "2"],
    ["newer libc requirement", "target.libcMinVersion", "2.37"],
    ["ABI mismatch", "target.nodeModulesAbi", "127"],
    ["Node major mismatch", "runtime.nodeMajor", 22],
    ["Yarn mismatch", "runtime.packageManager", "yarn@4.14.0"],
    ["zero size", "artifact.size", 0],
    ["oversized artifact", "artifact.size", 100 * 1024 * 1024 + 1],
    ["oversized expansion", "artifact.expandedSize", 512 * 1024 * 1024 + 1],
    [
      "oversized prepared tree",
      "artifact.maxPreparedSize",
      512 * 1024 * 1024 + 1,
    ],
    ["too many prepared files", "artifact.maxPreparedFiles", 20_001],
    ["too many archive files", "artifact.fileCount", 20_001],
    ["non-lowercase digest", "artifact.sha256", "A".repeat(64)],
  ])("rejects %s", (_name, path, value) => {
    const release = signed(mutate(validManifest(), path, value));
    expect(() =>
      verifySignedEnvelope(release.bytes, release.keys, policy, CHECK_TIME),
    ).toThrow();
  });

  it("rejects unknown keys at nested levels", () => {
    for (const path of ["target.extra", "artifact.extra", "runtime.extra"]) {
      const release = signed(mutate(validManifest(), path, true));
      expect(() =>
        verifySignedEnvelope(release.bytes, release.keys, policy, CHECK_TIME),
      ).toThrow(/unknown/i);
    }
  });

  it.each([
    ["0.9.9", "1.0.0", "upgrade"],
    ["1.0.0", "1.0.0", "current"],
    ["1.0.1", "1.0.0", "downgrade"],
    ["1.9.9", "1.10.0", "upgrade"],
  ] as const)(
    "classifies installed %s and candidate %s as %s",
    (installed, candidate, expected) => {
      expect(classifyStableRelease(installed, candidate)).toBe(expected);
    },
  );

  it.each(["1.0.0-rc.1", "1.0.0+build", "v1.0.0"])(
    "rejects non-stable comparison version %s",
    (version) => {
      expect(() => classifyStableRelease(version, "1.0.0")).toThrow();
    },
  );
});
