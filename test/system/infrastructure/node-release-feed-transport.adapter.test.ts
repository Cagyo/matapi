import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import type { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DownloadArtifactRequest,
  FetchEnvelopeRequest,
} from "../../../src/system/domain/ports/release-feed-transport.port";
import { NodeReleaseFeedTransportAdapter } from "../../../src/system/infrastructure/node-release-feed-transport.adapter";

type Handler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void | Promise<void>;

class LoopbackServer {
  readonly requests: {
    url: string;
    headers: IncomingMessage["headers"];
  }[] = [];

  private readonly sockets = new Set<Socket>();
  private handler: Handler = (_request, response) => {
    response.writeHead(500).end();
  };
  private readonly server = createServer((request, response) => {
    this.requests.push({ url: request.url ?? "", headers: request.headers });
    Promise.resolve(this.handler(request, response)).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : undefined);
    });
  });
  private origin = "";

  async start(): Promise<void> {
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolveListen) => {
      this.server.listen(0, "127.0.0.1", resolveListen);
    });
    const address = this.server.address();
    if (address === null || typeof address === "string")
      throw new Error("loopback server did not expose a TCP address");
    this.origin = `http://127.0.0.1:${address.port}`;
  }

  url(path = "/feed"): string {
    return new URL(path, this.origin).href;
  }

  handle(handler: Handler): void {
    this.handler = handler;
  }

  respond(
    status: number,
    headers: Record<string, string | number> = {},
    body: Uint8Array = Buffer.alloc(0),
  ): void {
    this.handle((_request, response) => {
      response.writeHead(status, headers);
      response.end(body);
    });
  }

  redirect(location: string): void {
    this.respond(302, { location });
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolveClose, reject) => {
      this.server.close((error) => (error ? reject(error) : resolveClose()));
    });
  }
}

const DEFAULT_TIMEOUTS = {
  connectMs: 500,
  firstByteMs: 500,
  idleMs: 500,
  totalMs: 2_000,
};
const STAGING_TOKEN = "00000000000000000000000000000001";

function stagingPath(destination: string): string {
  return resolve(
    dirname(destination),
    `.${basename(destination)}.ota-${STAGING_TOKEN}.partial`,
  );
}

function ioError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function resetResponse(headers: Record<string, string>): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("partial"));
        controller.error(new TypeError("connection reset"));
      },
    }),
    { status: 200, headers },
  );
}

describe("NodeReleaseFeedTransportAdapter", () => {
  let server: LoopbackServer;
  let evilServer: LoopbackServer;
  let transport: NodeReleaseFeedTransportAdapter;
  let temporaryRoot: string;
  let destination: string;

  beforeEach(async () => {
    server = new LoopbackServer();
    evilServer = new LoopbackServer();
    await Promise.all([server.start(), evilServer.start()]);
    transport = new NodeReleaseFeedTransportAdapter({
      allowInsecureLoopback: true,
      stagingNameSource: () => STAGING_TOKEN,
    });
    temporaryRoot = await mkdtemp(resolve(tmpdir(), "release-transport-"));
    destination = resolve(temporaryRoot, "artifact.tar.gz");
  });

  afterEach(async () => {
    await Promise.all([server.close(), evilServer.close()]);
    await chmod(temporaryRoot, 0o700).catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  function request(
    overrides: Partial<FetchEnvelopeRequest> = {},
  ): FetchEnvelopeRequest {
    return {
      url: server.url(),
      maxBytes: 96 * 1024,
      timeouts: DEFAULT_TIMEOUTS,
      ...overrides,
    };
  }

  it("treats an explicit null ETag as unconditional and rejects 304", async () => {
    server.respond(304);

    await expect(
      transport.fetchEnvelope(request({ etag: null })),
    ).rejects.toMatchObject({ code: "http-status" });
    expect(server.requests[0].headers["if-none-match"]).toBeUndefined();
  });

  function downloadRequest(
    overrides: Partial<DownloadArtifactRequest> = {},
  ): DownloadArtifactRequest {
    return {
      url: server.url("/artifact.tar.gz"),
      destination,
      expectedSize: 10,
      maxBytes: 100 * 1024 * 1024,
      timeouts: DEFAULT_TIMEOUTS,
      ...overrides,
    };
  }

  it("returns all identity response bytes and the strong ETag", async () => {
    const body = Buffer.from("complete envelope body");
    server.respond(
      200,
      {
        "content-encoding": "identity",
        "content-length": body.byteLength,
        etag: '"release-42"',
      },
      body,
    );

    const result = await transport.fetchEnvelope(request());

    expect(result).toEqual({ kind: "ok", bytes: body, etag: '"release-42"' });
    expect(server.requests[0].headers["accept-encoding"]).toBe("identity");
  });

  it("sends a conditional request and accepts 304 only for a cached ETag", async () => {
    server.respond(304);

    await expect(
      transport.fetchEnvelope(request({ etag: '"release-41"' })),
    ).resolves.toEqual({ kind: "not-modified" });
    expect(server.requests[0].headers["if-none-match"]).toBe('"release-41"');
  });

  it("rejects an unsolicited 304 response", async () => {
    server.respond(304);

    await expect(transport.fetchEnvelope(request())).rejects.toMatchObject({
      code: "http-status",
    });
  });

  it.each([206, 404, 500])("rejects HTTP status %s", async (status) => {
    server.respond(status, {}, Buffer.from("failure body"));

    await expect(transport.fetchEnvelope(request())).rejects.toMatchObject({
      code: status === 206 ? "archive-integrity" : "http-status",
    });
  });

  it.each(["gzip", "br"])(
    "rejects transformed %s responses",
    async (encoding) => {
      server.respond(
        200,
        { "content-encoding": encoding, etag: '"release-42"' },
        Buffer.from("body"),
      );
      await expect(transport.fetchEnvelope(request())).rejects.toMatchObject({
        code: "archive-integrity",
      });
    },
  );

  it.each([undefined, 'W/"release-42"', "release-42"])(
    "rejects a 200 envelope with missing or weak ETag %s",
    async (etag) => {
      server.respond(
        200,
        etag === undefined ? {} : { etag },
        Buffer.from("body"),
      );

      await expect(transport.fetchEnvelope(request())).rejects.toMatchObject({
        code: "archive-integrity",
      });
    },
  );

  it.each([
    ["control", '"release\t42"'],
    ["space", '"release 42"'],
  ])(
    "rejects a strong ETag containing a forbidden %s byte",
    async (_name, etag) => {
      server.respond(200, { etag }, Buffer.from("body"));

      await expect(transport.fetchEnvelope(request())).rejects.toMatchObject({
        code: "archive-integrity",
      });
    },
  );

  it("accepts backslash as a valid strong ETag character", async () => {
    const etag = String.raw`"release\42"`;
    server.respond(200, { etag }, Buffer.from("body"));

    await expect(transport.fetchEnvelope(request())).resolves.toMatchObject({
      kind: "ok",
      etag,
    });
  });

  it("follows at most three same-origin redirects", async () => {
    server.handle((incoming, response) => {
      const hop = Number(
        new URL(incoming.url ?? "/", server.url()).searchParams.get("hop") ??
          "0",
      );
      if (hop < 3) {
        response.writeHead(302, { location: `/feed?hop=${hop + 1}` }).end();
        return;
      }
      response.writeHead(200, { etag: '"release-42"' }).end("body");
    });

    await expect(transport.fetchEnvelope(request())).resolves.toMatchObject({
      kind: "ok",
      etag: '"release-42"',
    });
    expect(server.requests.map(({ url }) => url)).toEqual([
      "/feed",
      "/feed?hop=1",
      "/feed?hop=2",
      "/feed?hop=3",
    ]);
  });

  it("rejects a fourth same-origin redirect", async () => {
    server.handle((incoming, response) => {
      const hop = Number(
        new URL(incoming.url ?? "/", server.url()).searchParams.get("hop") ??
          "0",
      );
      response.writeHead(302, { location: `/feed?hop=${hop + 1}` }).end();
    });

    await expect(transport.fetchEnvelope(request())).rejects.toMatchObject({
      code: "redirect-rejected",
    });
    expect(server.requests).toHaveLength(4);
  });

  it("rejects a cross-origin redirect before sending a second request", async () => {
    server.redirect(evilServer.url("/feed"));
    await expect(transport.fetchEnvelope(request())).rejects.toMatchObject({
      code: "redirect-rejected",
    });
    expect(evilServer.requests).toHaveLength(0);
  });

  it("treats a different loopback port as a different normalized origin", async () => {
    server.redirect(evilServer.url("/artifact.tar.gz"));

    await expect(
      transport.downloadArtifact(downloadRequest()),
    ).rejects.toMatchObject({ code: "redirect-rejected" });
    expect(evilServer.requests).toHaveLength(0);
  });

  it("rejects insecure production URLs before making a request", async () => {
    const productionTransport = new NodeReleaseFeedTransportAdapter();

    await expect(
      productionTransport.fetchEnvelope(
        request({ url: "http://updates.example.com/feed" }),
      ),
    ).rejects.toMatchObject({ code: "redirect-rejected" });
  });

  it("enforces declared and streamed envelope ceilings", async () => {
    server.respond(
      200,
      { "content-length": 6, etag: '"release-42"' },
      Buffer.alloc(6),
    );
    await expect(
      transport.fetchEnvelope(request({ maxBytes: 5 })),
    ).rejects.toMatchObject({ code: "envelope-too-large" });

    server.handle((_incoming, response) => {
      response.writeHead(200, { etag: '"release-42"' });
      response.write(Buffer.alloc(3));
      response.end(Buffer.alloc(3));
    });
    await expect(
      transport.fetchEnvelope(request({ maxBytes: 5 })),
    ).rejects.toMatchObject({ code: "envelope-too-large" });
  });

  it("downloads an exact identity artifact through an exclusive 0600 file", async () => {
    const body = Buffer.from("0123456789");
    server.respond(
      200,
      {
        "content-encoding": "identity",
        "content-length": body.byteLength,
      },
      body,
    );

    await expect(
      transport.downloadArtifact(downloadRequest()),
    ).resolves.toEqual({
      size: body.byteLength,
      sha256: createHash("sha256").update(body).digest("hex"),
    });
    expect(await readFile(destination)).toEqual(body);
    expect((await stat(destination)).mode & 0o777).toBe(0o600);
    await expect(access(stagingPath(destination))).rejects.toThrow();
  });

  it("removes a partial artifact after the exact byte count is wrong", async () => {
    server.respond(200, {}, Buffer.alloc(9));
    await expect(
      transport.downloadArtifact(downloadRequest({ expectedSize: 10 })),
    ).rejects.toMatchObject({ code: "archive-integrity" });
    await expect(access(destination)).rejects.toThrow();
  });

  it("removes an artifact that exceeds the configured ceiling while streaming", async () => {
    server.handle((_incoming, response) => {
      response.writeHead(200);
      response.write(Buffer.alloc(6));
      response.end(Buffer.alloc(5));
    });

    await expect(
      transport.downloadArtifact(
        downloadRequest({ expectedSize: 10, maxBytes: 10 }),
      ),
    ).rejects.toMatchObject({ code: "archive-integrity" });
    await expect(access(destination)).rejects.toThrow();
  });

  it("never replaces a pre-existing destination", async () => {
    await writeFile(destination, "keep me", { mode: 0o600 });
    server.respond(200, {}, Buffer.alloc(10));

    await expect(
      transport.downloadArtifact(downloadRequest()),
    ).rejects.toMatchObject({ code: "maintenance-required" });
    expect(await readFile(destination, "utf8")).toBe("keep me");
    await expect(access(stagingPath(destination))).rejects.toThrow();
  });

  it("applies an independent connect timeout", async () => {
    server.handle(() => undefined);

    await expect(
      transport.fetchEnvelope(
        request({ timeouts: { ...DEFAULT_TIMEOUTS, connectMs: 35 } }),
      ),
    ).rejects.toMatchObject({ code: "network-timeout" });
  });

  it("applies an independent first-byte timeout after response headers", async () => {
    server.handle((_incoming, response) => {
      response.writeHead(200, {
        "content-length": 4,
        etag: '"release-42"',
      });
      response.flushHeaders();
    });

    await expect(
      transport.fetchEnvelope(
        request({ timeouts: { ...DEFAULT_TIMEOUTS, firstByteMs: 35 } }),
      ),
    ).rejects.toMatchObject({ code: "network-timeout" });
  });

  it("applies an independent idle-body timeout and removes partial files", async () => {
    server.handle((_incoming, response) => {
      response.writeHead(200, { "content-length": 10 });
      response.write("12345");
    });

    await expect(
      transport.downloadArtifact(
        downloadRequest({ timeouts: { ...DEFAULT_TIMEOUTS, idleMs: 35 } }),
      ),
    ).rejects.toMatchObject({ code: "network-timeout" });
    await expect(access(destination)).rejects.toThrow();
  });

  it("applies a total timeout independently of active body traffic", async () => {
    server.handle((_incoming, response) => {
      response.writeHead(200, { etag: '"release-42"' });
      const interval = setInterval(() => response.write("x"), 15);
      response.on("close", () => clearInterval(interval));
    });

    await expect(
      transport.fetchEnvelope(
        request({
          maxBytes: 1_000,
          timeouts: { ...DEFAULT_TIMEOUTS, idleMs: 100, totalMs: 70 },
        }),
      ),
    ).rejects.toMatchObject({ code: "network-timeout" });
  });

  it("honors caller cancellation and removes partial files", async () => {
    const controller = new AbortController();
    server.handle((_incoming, response) => {
      response.writeHead(200, { "content-length": 10 });
      response.write("12345");
    });
    const pending = transport.downloadArtifact(
      downloadRequest({ signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 25);

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(access(destination)).rejects.toThrow();
  });

  it("maps a post-header envelope stream reset to network-unavailable", async () => {
    const resetTransport = new NodeReleaseFeedTransportAdapter({
      allowInsecureLoopback: true,
      fetch: async () => resetResponse({ etag: '"release-42"' }),
    });

    await expect(resetTransport.fetchEnvelope(request())).rejects.toMatchObject(
      { code: "network-unavailable" },
    );
  });

  it("maps a post-header artifact stream reset and removes its partial file", async () => {
    const resetTransport = new NodeReleaseFeedTransportAdapter({
      allowInsecureLoopback: true,
      fetch: async () => resetResponse({ "content-length": "10" }),
      stagingNameSource: () => STAGING_TOKEN,
    });

    await expect(
      resetTransport.downloadArtifact(downloadRequest()),
    ).rejects.toMatchObject({ code: "network-unavailable" });
    await expect(access(destination)).rejects.toThrow();
    await expect(access(stagingPath(destination))).rejects.toThrow();
  });

  it("preserves the primary transfer failure after cleanup proves absence", async () => {
    server.respond(200, {}, Buffer.alloc(9));
    const writer = {
      chmodPrivate: vi.fn().mockResolvedValue(undefined),
      write: vi.fn().mockResolvedValue(undefined),
      sync: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    const fileSystem = {
      openExclusive: vi.fn().mockResolvedValue(writer),
      link: vi.fn(),
      unlink: vi.fn().mockResolvedValue(undefined),
      fsyncDirectory: vi.fn(),
    };
    const injectedTransport = new NodeReleaseFeedTransportAdapter({
      allowInsecureLoopback: true,
      fileSystem,
      stagingNameSource: () => STAGING_TOKEN,
    });

    await expect(
      injectedTransport.downloadArtifact(downloadRequest()),
    ).rejects.toMatchObject({ code: "archive-integrity" });
    expect(writer.close).toHaveBeenCalled();
    expect(writer.close).toHaveBeenCalledTimes(1);
    expect(fileSystem.unlink).toHaveBeenCalledTimes(1);
    expect(fileSystem.unlink).toHaveBeenCalledWith(stagingPath(destination));
    expect(fileSystem.unlink).not.toHaveBeenCalledWith(destination);
  });

  it("overrides a primary failure when its single staging unlink fails", async () => {
    server.respond(200, {}, Buffer.alloc(9));
    const writer = {
      chmodPrivate: vi.fn().mockResolvedValue(undefined),
      write: vi.fn().mockResolvedValue(undefined),
      sync: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    const fileSystem = {
      openExclusive: vi.fn().mockResolvedValue(writer),
      link: vi.fn(),
      unlink: vi.fn().mockRejectedValue(ioError("EACCES")),
      fsyncDirectory: vi.fn(),
    };
    const injectedTransport = new NodeReleaseFeedTransportAdapter({
      allowInsecureLoopback: true,
      fileSystem,
      stagingNameSource: () => STAGING_TOKEN,
    });

    await expect(
      injectedTransport.downloadArtifact(downloadRequest()),
    ).rejects.toMatchObject({ code: "maintenance-required" });
    expect(fileSystem.unlink).toHaveBeenCalledTimes(1);
    expect(fileSystem.unlink).toHaveBeenCalledWith(stagingPath(destination));
    expect(fileSystem.unlink).not.toHaveBeenCalledWith(destination);
  });

  it("maps local writer failures to disk-resource after proven cleanup", async () => {
    server.respond(200, {}, Buffer.alloc(10));
    const writer = {
      chmodPrivate: vi.fn().mockResolvedValue(undefined),
      write: vi.fn().mockRejectedValue(ioError("EIO")),
      sync: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    const fileSystem = {
      openExclusive: vi.fn().mockResolvedValue(writer),
      link: vi.fn(),
      unlink: vi.fn().mockResolvedValue(undefined),
      fsyncDirectory: vi.fn(),
    };
    const injectedTransport = new NodeReleaseFeedTransportAdapter({
      allowInsecureLoopback: true,
      fileSystem,
      stagingNameSource: () => STAGING_TOKEN,
    });

    await expect(
      injectedTransport.downloadArtifact(downloadRequest()),
    ).rejects.toMatchObject({ code: "disk-resource" });
    expect(fileSystem.unlink).toHaveBeenCalledWith(stagingPath(destination));
    expect(fileSystem.unlink).not.toHaveBeenCalledWith(destination);
  });

  it("maps an exclusive staging-open EEXIST failure to maintenance-required", async () => {
    server.respond(200, {}, Buffer.alloc(10));
    const fileSystem = {
      openExclusive: vi.fn().mockRejectedValue(ioError("EEXIST")),
      link: vi.fn(),
      unlink: vi.fn(),
      fsyncDirectory: vi.fn(),
    };
    const injectedTransport = new NodeReleaseFeedTransportAdapter({
      allowInsecureLoopback: true,
      fileSystem,
      stagingNameSource: () => STAGING_TOKEN,
    });

    await expect(
      injectedTransport.downloadArtifact(downloadRequest()),
    ).rejects.toMatchObject({ code: "maintenance-required" });
    expect(fileSystem.unlink).not.toHaveBeenCalled();
  });

  it("poisons future downloads when close and destroy cannot confirm terminal close", async () => {
    server.respond(200, {}, Buffer.alloc(10));
    const writer = {
      chmodPrivate: vi.fn().mockResolvedValue(undefined),
      write: vi.fn().mockResolvedValue(undefined),
      sync: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockRejectedValue(ioError("EIO")),
      destroy: vi.fn().mockRejectedValue(ioError("EIO")),
    };
    const fileSystem = {
      openExclusive: vi.fn().mockResolvedValue(writer),
      link: vi.fn(),
      unlink: vi.fn().mockResolvedValue(undefined),
      fsyncDirectory: vi.fn(),
    };
    const injectedTransport = new NodeReleaseFeedTransportAdapter({
      allowInsecureLoopback: true,
      fileSystem,
      stagingNameSource: () => STAGING_TOKEN,
    });

    await expect(
      injectedTransport.downloadArtifact(downloadRequest()),
    ).rejects.toMatchObject({ code: "maintenance-required" });
    const requestCount = server.requests.length;
    await expect(
      injectedTransport.downloadArtifact(downloadRequest()),
    ).rejects.toMatchObject({ code: "maintenance-required" });
    expect(server.requests).toHaveLength(requestCount);
    expect(writer.close).toHaveBeenCalledTimes(1);
    expect(writer.destroy).toHaveBeenCalledTimes(1);
    expect(fileSystem.link).not.toHaveBeenCalled();
    expect(fileSystem.unlink).toHaveBeenCalledTimes(1);
    expect(fileSystem.unlink).toHaveBeenCalledWith(stagingPath(destination));
    expect(fileSystem.unlink).not.toHaveBeenCalledWith(destination);
  });

  it("publishes a verified staging inode without ever unlinking the final destination", async () => {
    server.respond(200, {}, Buffer.alloc(10));
    const writer = {
      chmodPrivate: vi.fn().mockResolvedValue(undefined),
      write: vi.fn().mockResolvedValue(undefined),
      sync: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn(),
    };
    const fileSystem = {
      openExclusive: vi.fn().mockResolvedValue(writer),
      link: vi.fn().mockResolvedValue(undefined),
      unlink: vi.fn().mockResolvedValue(undefined),
      fsyncDirectory: vi.fn().mockResolvedValue(undefined),
    };
    const injectedTransport = new NodeReleaseFeedTransportAdapter({
      allowInsecureLoopback: true,
      fileSystem,
      stagingNameSource: () => STAGING_TOKEN,
    });

    await expect(
      injectedTransport.downloadArtifact(downloadRequest()),
    ).resolves.toMatchObject({ size: 10 });
    expect(fileSystem.openExclusive).toHaveBeenCalledWith(
      stagingPath(destination),
    );
    expect(writer.close).toHaveBeenCalledTimes(1);
    expect(writer.destroy).not.toHaveBeenCalled();
    expect(fileSystem.link).toHaveBeenCalledWith(
      stagingPath(destination),
      destination,
    );
    expect(fileSystem.fsyncDirectory).toHaveBeenNthCalledWith(
      1,
      dirname(destination),
    );
    expect(fileSystem.unlink).toHaveBeenCalledTimes(1);
    expect(fileSystem.unlink).toHaveBeenCalledWith(stagingPath(destination));
    expect(fileSystem.unlink).not.toHaveBeenCalledWith(destination);
    expect(fileSystem.fsyncDirectory).toHaveBeenNthCalledWith(
      2,
      dirname(destination),
    );
    expect(writer.close.mock.invocationCallOrder[0]).toBeLessThan(
      fileSystem.link.mock.invocationCallOrder[0],
    );
    expect(fileSystem.link.mock.invocationCallOrder[0]).toBeLessThan(
      fileSystem.fsyncDirectory.mock.invocationCallOrder[0],
    );
    expect(fileSystem.fsyncDirectory.mock.invocationCallOrder[0]).toBeLessThan(
      fileSystem.unlink.mock.invocationCallOrder[0],
    );
    expect(fileSystem.unlink.mock.invocationCallOrder[0]).toBeLessThan(
      fileSystem.fsyncDirectory.mock.invocationCallOrder[1],
    );
  });

  it("preserves a successor that appears between verification and link publication", async () => {
    server.respond(200, {}, Buffer.alloc(10));
    const paths = new Map<string, string>();
    const writer = {
      chmodPrivate: vi.fn().mockResolvedValue(undefined),
      write: vi.fn().mockResolvedValue(undefined),
      sync: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn(),
    };
    const fileSystem = {
      openExclusive: vi.fn(async (path: string) => {
        paths.set(path, "verified");
        return writer;
      }),
      link: vi.fn(async () => {
        paths.set(destination, "successor");
        throw ioError("EEXIST");
      }),
      unlink: vi.fn(async (path: string) => {
        paths.delete(path);
      }),
      fsyncDirectory: vi.fn(),
    };
    const injectedTransport = new NodeReleaseFeedTransportAdapter({
      allowInsecureLoopback: true,
      fileSystem,
      stagingNameSource: () => STAGING_TOKEN,
    });

    await expect(
      injectedTransport.downloadArtifact(downloadRequest()),
    ).rejects.toMatchObject({ code: "maintenance-required" });
    expect(paths.get(destination)).toBe("successor");
    expect(paths.has(stagingPath(destination))).toBe(false);
    expect(fileSystem.unlink).toHaveBeenCalledTimes(1);
    expect(fileSystem.unlink).toHaveBeenCalledWith(stagingPath(destination));
    expect(fileSystem.unlink).not.toHaveBeenCalledWith(destination);
  });

  it("keeps both verified links and requires maintenance after a post-link fsync failure", async () => {
    server.respond(200, {}, Buffer.alloc(10));
    const controller = new AbortController();
    const paths = new Map<string, string>();
    const writer = {
      chmodPrivate: vi.fn().mockResolvedValue(undefined),
      write: vi.fn().mockResolvedValue(undefined),
      sync: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn(),
    };
    const fileSystem = {
      openExclusive: vi.fn(async (path: string) => {
        paths.set(path, "verified");
        return writer;
      }),
      link: vi.fn(async (from: string, to: string) => {
        paths.set(to, paths.get(from)!);
      }),
      unlink: vi.fn(async (path: string) => {
        paths.delete(path);
      }),
      fsyncDirectory: vi.fn(async () => {
        controller.abort();
        throw ioError("EIO");
      }),
    };
    const injectedTransport = new NodeReleaseFeedTransportAdapter({
      allowInsecureLoopback: true,
      fileSystem,
      stagingNameSource: () => STAGING_TOKEN,
    });

    await expect(
      injectedTransport.downloadArtifact(
        downloadRequest({ signal: controller.signal }),
      ),
    ).rejects.toMatchObject({ code: "maintenance-required" });
    expect(paths.get(destination)).toBe("verified");
    expect(paths.get(stagingPath(destination))).toBe("verified");
    expect(fileSystem.unlink).not.toHaveBeenCalled();
  });

  it("preserves maintenance when caller abort races a failed post-link staging unlink", async () => {
    server.respond(200, {}, Buffer.alloc(10));
    const controller = new AbortController();
    const paths = new Map<string, string>();
    const writer = {
      chmodPrivate: vi.fn().mockResolvedValue(undefined),
      write: vi.fn().mockResolvedValue(undefined),
      sync: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn(),
    };
    const fileSystem = {
      openExclusive: vi.fn(async (path: string) => {
        paths.set(path, "verified");
        return writer;
      }),
      link: vi.fn(async (from: string, to: string) => {
        paths.set(to, paths.get(from)!);
      }),
      unlink: vi.fn(async () => {
        controller.abort();
        throw ioError("EACCES");
      }),
      fsyncDirectory: vi.fn().mockResolvedValue(undefined),
    };
    const injectedTransport = new NodeReleaseFeedTransportAdapter({
      allowInsecureLoopback: true,
      fileSystem,
      stagingNameSource: () => STAGING_TOKEN,
    });

    await expect(
      injectedTransport.downloadArtifact(
        downloadRequest({ signal: controller.signal }),
      ),
    ).rejects.toMatchObject({ code: "maintenance-required" });
    expect(paths.get(destination)).toBe("verified");
    expect(paths.get(stagingPath(destination))).toBe("verified");
    expect(fileSystem.unlink).toHaveBeenCalledTimes(1);
    expect(fileSystem.unlink).not.toHaveBeenCalledWith(destination);
  });

  it("preserves maintenance when caller abort races the second parent fsync failure", async () => {
    server.respond(200, {}, Buffer.alloc(10));
    const controller = new AbortController();
    const paths = new Map<string, string>();
    let fsyncCount = 0;
    const writer = {
      chmodPrivate: vi.fn().mockResolvedValue(undefined),
      write: vi.fn().mockResolvedValue(undefined),
      sync: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn(),
    };
    const fileSystem = {
      openExclusive: vi.fn(async (path: string) => {
        paths.set(path, "verified");
        return writer;
      }),
      link: vi.fn(async (from: string, to: string) => {
        paths.set(to, paths.get(from)!);
      }),
      unlink: vi.fn(async (path: string) => {
        paths.delete(path);
      }),
      fsyncDirectory: vi.fn(async () => {
        fsyncCount += 1;
        if (fsyncCount === 2) {
          controller.abort();
          throw ioError("EIO");
        }
      }),
    };
    const injectedTransport = new NodeReleaseFeedTransportAdapter({
      allowInsecureLoopback: true,
      fileSystem,
      stagingNameSource: () => STAGING_TOKEN,
    });

    await expect(
      injectedTransport.downloadArtifact(
        downloadRequest({ signal: controller.signal }),
      ),
    ).rejects.toMatchObject({ code: "maintenance-required" });
    expect(paths.get(destination)).toBe("verified");
    expect(paths.has(stagingPath(destination))).toBe(false);
    expect(fileSystem.unlink).toHaveBeenCalledTimes(1);
    expect(fileSystem.unlink).not.toHaveBeenCalledWith(destination);
  });

  it("uses destroy once to confirm terminal close before publication", async () => {
    server.respond(200, {}, Buffer.alloc(10));
    const writer = {
      chmodPrivate: vi.fn().mockResolvedValue(undefined),
      write: vi.fn().mockResolvedValue(undefined),
      sync: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockRejectedValue(ioError("EIO")),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    const fileSystem = {
      openExclusive: vi.fn().mockResolvedValue(writer),
      link: vi.fn().mockResolvedValue(undefined),
      unlink: vi.fn().mockResolvedValue(undefined),
      fsyncDirectory: vi.fn().mockResolvedValue(undefined),
    };
    const injectedTransport = new NodeReleaseFeedTransportAdapter({
      allowInsecureLoopback: true,
      fileSystem,
      stagingNameSource: () => STAGING_TOKEN,
    });

    await expect(
      injectedTransport.downloadArtifact(downloadRequest()),
    ).resolves.toMatchObject({ size: 10 });
    expect(writer.close).toHaveBeenCalledTimes(1);
    expect(writer.destroy).toHaveBeenCalledTimes(1);
    expect(fileSystem.link).toHaveBeenCalledWith(
      stagingPath(destination),
      destination,
    );
  });

  it("does not let caller cancellation race a final clean EOF", async () => {
    const controller = new AbortController();
    let pullCount = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(streamController) {
          if (pullCount++ === 0) {
            streamController.enqueue(Buffer.from("body"));
            return;
          }
          controller.abort();
          streamController.close();
        },
      },
      { highWaterMark: 0 },
    );
    const raceTransport = new NodeReleaseFeedTransportAdapter({
      allowInsecureLoopback: true,
      fetch: async () =>
        new Response(body, { status: 200, headers: { etag: '"release-42"' } }),
    });

    await expect(
      raceTransport.fetchEnvelope(request({ signal: controller.signal })),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not let caller cancellation race a 304 success", async () => {
    const controller = new AbortController();
    const raceTransport = new NodeReleaseFeedTransportAdapter({
      allowInsecureLoopback: true,
      fetch: async () => {
        controller.abort();
        return new Response(null, { status: 304 });
      },
    });

    await expect(
      raceTransport.fetchEnvelope(
        request({ etag: '"release-41"', signal: controller.signal }),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
