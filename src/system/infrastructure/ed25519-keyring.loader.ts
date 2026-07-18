import { createHash, createPublicKey, type KeyObject } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { ActiveKey } from "../domain/signed-manifest";

function loadKeys(directory: string): ActiveKey[] {
  let names: string[];
  try {
    names = readdirSync(directory)
      .filter((name) => name.endsWith(".pem"))
      .sort();
  } catch {
    return [];
  }

  const keys: ActiveKey[] = [];
  const keyIds = new Set<string>();
  for (const name of names) {
    const path = resolve(directory, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      const publicKey = createPublicKey(readFileSync(path));
      const loaded = toEd25519Key(publicKey);
      if (loaded === null || keyIds.has(loaded.keyId)) continue;
      keyIds.add(loaded.keyId);
      keys.push(loaded);
    } catch {
      continue;
    }
  }
  return keys;
}

function toEd25519Key(publicKey: KeyObject): ActiveKey | null {
  if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519")
    return null;
  const der = publicKey.export({ format: "der", type: "spki" });
  const keyId = createHash("sha256").update(der).digest("hex");
  return { keyId, publicKey };
}

export function loadActiveKeys(trustDirectory: string): ActiveKey[] {
  return loadKeys(resolve(trustDirectory, "active"));
}

export function loadRetiredKeys(trustDirectory: string): ActiveKey[] {
  return loadKeys(resolve(trustDirectory, "retired"));
}
