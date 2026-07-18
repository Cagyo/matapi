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
import { resolve } from "node:path";
import type { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    ).rejects.toThrow();
    expect(await readFile(destination, "utf8")).toBe("keep me");
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
});
