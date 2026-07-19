import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import tar from "tar-stream";

interface TarFixtureEntry {
  name: string;
  body?: Buffer;
  mode?: number;
  type?: tar.Headers["type"];
  linkname?: string;
  pax?: Record<string, string>;
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
    "directory-slash.tar.gz": await tarGz([
      { name: "dist/", type: "directory" },
      { name: "dist/main.js", body: Buffer.from("ok") },
    ]),
    "file-trailing-slash.tar.gz": await tarGz([
      { name: "file/", body: Buffer.from("x") },
    ]),
    "duplicate-directory-slash.tar.gz": await tarGz([
      { name: "dist/", type: "directory" },
      { name: "dist", type: "directory" },
    ]),
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
}
