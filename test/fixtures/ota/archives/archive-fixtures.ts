import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateRawSync, gzipSync, gunzipSync } from "node:zlib";
import tar from "tar-stream";

interface TarFixtureEntry {
  name: string;
  body?: Buffer;
  mode?: number;
  type?: tar.Headers["type"];
  linkname?: string;
  pax?: Record<string, string>;
}

interface ZipFixtureEntry {
  name: string;
  body?: Buffer;
  storedBody?: Buffer;
  flags?: number;
  method?: number;
  declaredSize?: number;
}

function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    stream.once("error", reject);
    stream.once("end", () => resolve(Buffer.concat(chunks)));
  });
}

async function tarGz(entries: TarFixtureEntry[]): Promise<Buffer> {
  const pack = tar.pack();
  const output = collect(pack);

  for (const entry of entries) {
    const body = entry.body ?? Buffer.alloc(0);
    await new Promise<void>((resolve, reject) => {
      pack.entry(
        {
          name: entry.name,
          mode: entry.mode ?? (entry.type === "directory" ? 0o755 : 0o644),
          size: body.length,
          type: entry.type ?? "file",
          linkname: entry.linkname,
          pax: entry.pax,
          mtime: new Date(0),
          uid: 0,
          gid: 0,
        },
        body,
        (error) => (error ? reject(error) : resolve()),
      );
    });
  }
  pack.finalize();
  return gzipSync(await output, { mtime: 0 });
}

function tarChecksum(header: Buffer): void {
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  const encoded = sum.toString(8).padStart(6, "0");
  header.write(encoded, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries: ZipFixtureEntry[]): Buffer {
  const localRecords: Buffer[] = [];
  const centralRecords: Buffer[] = [];
  let offset = 0;

  for (const fixture of entries) {
    const name = Buffer.from(fixture.name, "utf8");
    const body = fixture.body ?? Buffer.alloc(0);
    const method = fixture.method ?? 0;
    const compressed =
      fixture.storedBody ?? (method === 8 ? deflateRawSync(body) : body);
    const flags = fixture.flags ?? 0x800;
    const declaredSize = fixture.declaredSize ?? body.length;
    const checksum = crc32(body);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(declaredSize, 22);
    local.writeUInt16LE(name.length, 26);
    const localRecord = Buffer.concat([local, name, compressed]);
    localRecords.push(localRecord);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(declaredSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralRecords.push(Buffer.concat([central, name]));
    offset += localRecord.length;
  }

  const centralDirectory = Buffer.concat(centralRecords);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localRecords, centralDirectory, end]);
}

export async function writeOtaArchiveFixtures(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  const valid = await tarGz([
    { name: "dist", type: "directory" },
    { name: "dist/main.js", body: Buffer.from("ok") },
    { name: "scripts", type: "directory" },
    {
      name: "scripts/update.sh",
      body: Buffer.from("#!/bin/sh\nexit 0\n"),
      mode: 0o755,
    },
  ]);
  const invalidUtf8Tar = gunzipSync(
    await tarGz([{ name: "invalid", body: Buffer.from("x") }]),
  );
  invalidUtf8Tar[0] = 0xff;
  tarChecksum(invalidUtf8Tar.subarray(0, 512));
  const sparseTar = gunzipSync(await tarGz([{ name: "sparse" }]));
  sparseTar[156] = "S".charCodeAt(0);
  tarChecksum(sparseTar.subarray(0, 512));

  const tarFixtures: Record<string, Buffer> = {
    "valid.tar.gz": valid,
    "absolute.tar.gz": await tarGz([
      { name: "/etc/passwd", body: Buffer.from("x") },
    ]),
    "dotdot.tar.gz": await tarGz([
      { name: "../escape", body: Buffer.from("x") },
    ]),
    "symlink.tar.gz": await tarGz([
      { name: "link", type: "symlink", linkname: "dist/main.js" },
    ]),
    "hardlink.tar.gz": await tarGz([
      { name: "link", type: "link", linkname: "dist/main.js" },
    ]),
    "device.tar.gz": await tarGz([{ name: "device", type: "block-device" }]),
    "fifo.tar.gz": await tarGz([{ name: "pipe", type: "fifo" }]),
    "sparse.tar.gz": gzipSync(sparseTar, { mtime: 0 }),
    "pax.tar.gz": await tarGz([
      { name: "pax", body: Buffer.from("x"), pax: { comment: "forbidden" } },
    ]),
    "duplicate.tar.gz": await tarGz([
      { name: "same", body: Buffer.from("a") },
      { name: "same", body: Buffer.from("b") },
    ]),
    "control-char.tar.gz": await tarGz([
      { name: "bad\u0001name", body: Buffer.from("x") },
    ]),
    "invalid-utf8.tar.gz": gzipSync(invalidUtf8Tar, { mtime: 0 }),
    "setuid.tar.gz": await tarGz([
      { name: "setuid", body: Buffer.from("x"), mode: 0o4755 },
    ]),
    "world-writable.tar.gz": await tarGz([
      { name: "writable", body: Buffer.from("x"), mode: 0o666 },
    ]),
    "truncated.tar.gz": valid.subarray(0, valid.length - 8),
    "trailing-data.tar.gz": Buffer.concat([valid, Buffer.from("trailing")]),
    "trailing-tar-data.tar.gz": gzipSync(
      Buffer.concat([gunzipSync(valid), Buffer.from("trailing")]),
      { mtime: 0 },
    ),
  };

  for (const [name, bytes] of Object.entries(tarFixtures)) {
    await writeFile(join(root, name), bytes);
  }

  const zipFixtures: Record<string, Buffer> = {
    "valid.zip": zip([
      {
        name: "node_modules/pkg/package.json",
        body: Buffer.from('{"name":"pkg"}'),
      },
      {
        name: "node_modules/pkg/index.js",
        body: Buffer.from("module.exports=1"),
      },
    ]),
    "encrypted.zip": zip([
      {
        name: "node_modules/pkg/secret",
        body: Buffer.from("x"),
        storedBody: Buffer.alloc(13),
        flags: 0x801,
      },
    ]),
    "traversal.zip": zip([{ name: "../outside", body: Buffer.from("x") }]),
    "duplicate.zip": zip([
      { name: "node_modules/pkg/a", body: Buffer.from("a") },
      { name: "node_modules/pkg/a", body: Buffer.from("b") },
    ]),
    "bomb.zip": zip([
      {
        name: "node_modules/pkg/bomb",
        body: Buffer.from("x"),
        method: 8,
        declaredSize: 4096,
      },
    ]),
    "unsupported-method.zip": zip([{ name: "node_modules/pkg/a", method: 99 }]),
  };

  const cacheCases = join(root, "cache-cases");
  for (const [name, bytes] of Object.entries(zipFixtures)) {
    const caseRoot = join(cacheCases, name);
    await mkdir(caseRoot, { recursive: true });
    await writeFile(join(caseRoot, name), bytes);
  }
}

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
