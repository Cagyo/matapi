import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadActiveKeys,
  loadRetiredKeys,
} from "../../../src/system/infrastructure/ed25519-keyring.loader";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function trustDirectory(): string {
  mkdirSync(resolve("test/.tmp"), { recursive: true });
  const root = mkdtempSync(resolve("test/.tmp/keyring-"));
  roots.push(root);
  mkdirSync(resolve(root, "active"));
  mkdirSync(resolve(root, "retired"));
  return root;
}

function id(publicKey: KeyObject): string {
  return createHash("sha256")
    .update(publicKey.export({ format: "der", type: "spki" }))
    .digest("hex");
}

function pem(publicKey: KeyObject): string {
  return publicKey.export({ format: "pem", type: "spki" }).toString();
}

describe("Ed25519 keyring loader", () => {
  it("loads regular Ed25519 PEM files and derives SPKI SHA-256 key IDs", () => {
    const root = trustDirectory();
    const { publicKey } = generateKeyPairSync("ed25519");
    writeFileSync(resolve(root, "active/publisher.pem"), pem(publicKey));

    const keys = loadActiveKeys(root);

    expect(keys).toHaveLength(1);
    expect(keys[0].keyId).toBe(id(publicKey));
    expect(keys[0].publicKey.asymmetricKeyType).toBe("ed25519");
  });

  it("ignores malformed, unknown, non-Ed25519, duplicate, non-PEM, and symlink entries", () => {
    const root = trustDirectory();
    const ed25519 = generateKeyPairSync("ed25519").publicKey;
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey;
    writeFileSync(resolve(root, "active/a.pem"), pem(ed25519));
    writeFileSync(resolve(root, "active/duplicate.pem"), pem(ed25519));
    writeFileSync(resolve(root, "active/rsa.pem"), pem(rsa));
    writeFileSync(resolve(root, "active/malformed.pem"), "not a key");
    writeFileSync(resolve(root, "active/ignored.txt"), pem(ed25519));
    mkdirSync(resolve(root, "active/directory.pem"));
    symlinkSync(
      resolve(root, "active/a.pem"),
      resolve(root, "active/link.pem"),
    );

    expect(loadActiveKeys(root).map((key) => key.keyId)).toEqual([id(ed25519)]);
  });

  it("keeps retired keys separate from active feed verification keys", () => {
    const root = trustDirectory();
    const active = generateKeyPairSync("ed25519").publicKey;
    const retired = generateKeyPairSync("ed25519").publicKey;
    writeFileSync(resolve(root, "active/active.pem"), pem(active));
    writeFileSync(resolve(root, "retired/retired.pem"), pem(retired));

    expect(loadActiveKeys(root).map((key) => key.keyId)).toEqual([id(active)]);
    expect(loadRetiredKeys(root).map((key) => key.keyId)).toEqual([
      id(retired),
    ]);
  });

  it("returns an empty keyring when the selected directory is missing", () => {
    const root = trustDirectory();
    rmSync(resolve(root, "active"), { recursive: true });
    expect(loadActiveKeys(root)).toEqual([]);
  });
});
