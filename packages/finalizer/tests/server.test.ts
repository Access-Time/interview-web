import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readdir,
  readFile,
  truncate,
  writeFile,
} from "node:fs/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
} from "node:http";
import { connect as tcpConnect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeHttpServer } from "@effect/platform-node";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { FfmpegFailed } from "../src/domain/errors.ts";
import { makeFfmpegTest } from "../src/server/ffmpeg.ts";
import { finalizerHttpApp } from "../src/server/http.ts";
import { makeJobStoreTest } from "../src/server/job-store.ts";

interface Response {
  body: Buffer;
  headers: Record<string, string | string[] | undefined>;
  status: number;
}
interface Harness {
  close: () => Promise<void>;
  port: number;
  request: (
    method: string,
    route: string,
    body?: Buffer | string,
    headers?: Record<string, string>
  ) => Promise<Response>;
  root: string;
}
const harnesses: Harness[] = [];
const sha = (body: Buffer) => createHash("sha256").update(body).digest("hex");
const httpStatusPattern = /^HTTP\/1\.1 (\d+)/;

async function harness(
  failFfmpeg = false,
  deferredFfmpeg?: Promise<void>
): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), "finalizer-test-"));
  const ffmpeg = {
    concat: (input: { listPath: string; outputPath: string; cwd: string }) =>
      Effect.tryPromise(async () => {
        await writeFile(input.outputPath, await readFile(input.listPath));
      }),
    probe: () => Effect.succeed(undefined),
    remux: (input: { inputPath: string; outputPath: string; cwd: string }) =>
      failFfmpeg
        ? Effect.fail(new FfmpegFailed({ message: "ffmpeg failed" }))
        : Effect.tryPromise(async () => {
            await deferredFfmpeg;
            await writeFile(input.outputPath, await readFile(input.inputPath));
          }),
  } as unknown as Parameters<typeof makeFfmpegTest>[0];
  const app = finalizerHttpApp.pipe(
    Effect.provide(makeJobStoreTest(root)),
    Effect.provide(makeFfmpegTest(ffmpeg))
  );
  const handler = await Effect.runPromise(
    NodeHttpServer.makeHandler(app).pipe(
      Effect.provide(NodeHttpServer.layerContext)
    )
  );
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server did not bind");
  }
  const request = (
    method: string,
    route: string,
    body?: Buffer | string,
    headers: Record<string, string> = {}
  ) =>
    new Promise<Response>((resolve, reject) => {
      const clientRequest = httpRequest(
        { headers, method, path: route, port: address.port },
        (response: IncomingMessage) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            resolve({
              body: Buffer.concat(chunks),
              headers: response.headers,
              status: response.statusCode ?? 0,
            })
          );
        }
      );
      clientRequest.on("error", reject);
      if (body) {
        clientRequest.write(body);
      }
      clientRequest.end();
    });
  const value = {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    port: address.port,
    request,
    root,
  };
  harnesses.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((value) => value.close()));
});

const upload = (h: Harness, segment: number, sequence: number, bytes: Buffer) =>
  h.request("PUT", `/jobs/job/parts/${segment}/${sequence}`, bytes, {
    "x-content-sha256": sha(bytes),
  });

const finalize = (h: Harness) =>
  h.request(
    "POST",
    "/jobs/job/finalize",
    JSON.stringify({
      outputMediaType: "video/webm",
      segments: [{ partIndexes: [0], segmentIndex: 0 }],
    }),
    { "content-type": "application/json" }
  );

it("preserves health, method, checksum, and idempotent part protocol", async () => {
  const h = await harness();
  expect((await h.request("GET", "/health")).status).toBe(204);
  expect((await h.request("PATCH", "/health")).status).toBe(404);
  const body = Buffer.from("ab");
  const headers = {
    "content-length": String(body.length),
    "x-content-sha256": sha(body),
  };
  expect(
    (await h.request("PUT", "/jobs/job/parts/0/0", body, headers)).status
  ).toBe(201);
  expect(
    (await h.request("PUT", "/jobs/job/parts/0/0", body, headers)).status
  ).toBe(200);
  expect(
    (
      await h.request("PUT", "/jobs/job/parts/0/1", body, {
        "x-content-sha256": "bad",
      })
    ).status
  ).toBe(400);
  expect(
    (
      await h.request("PUT", "/jobs/job/parts/0/0", Buffer.from("other"), {
        "x-content-sha256": sha(Buffer.from("other")),
      })
    ).status
  ).toBe(409);
});

it("serializes identical and conflicting concurrent uploads", async () => {
  const h = await harness();
  const [sameA, sameB] = await Promise.all([
    upload(h, 0, 0, Buffer.from("same")),
    upload(h, 0, 0, Buffer.from("same")),
  ]);
  expect([sameA.status, sameB.status].sort()).toEqual([200, 201]);
  const [differentA, differentB] = await Promise.all([
    upload(h, 0, 1, Buffer.from("a")),
    upload(h, 0, 1, Buffer.from("b")),
  ]);
  expect([differentA.status, differentB.status].sort()).toEqual([201, 409]);
});

it("enforces the aggregate cap for concurrent uploads", async () => {
  const h = await harness();
  await upload(h, 0, 0, Buffer.from("seed"));
  await truncate(
    path.join(h.root, "job", "part-0-0.bin"),
    2 * 1024 * 1024 * 1024 - 1
  );
  const [first, second] = await Promise.all([
    upload(h, 0, 1, Buffer.from("a")),
    upload(h, 0, 2, Buffer.from("b")),
  ]);
  expect([first.status, second.status].sort()).toEqual([201, 413]);
  expect(
    (await readdir(path.join(h.root, "job"))).filter((name) =>
      name.endsWith(".bin")
    )
  ).toHaveLength(2);
});

it("rejects chunked oversized bodies without accepting parts", async () => {
  const h = await harness();
  const chunked = await h.request(
    "POST",
    "/jobs/job/finalize",
    Buffer.alloc(2 * 1024 * 1024 + 1, 32),
    { "content-type": "application/json" }
  );
  expect(chunked.status).toBe(413);
  expect((await finalize(h)).status).toBe(409);
});

it("rejects a declared oversized part before its body is transmitted", async () => {
  const h = await harness();
  const declaredLength = 512 * 1024 * 1024 + 1;
  const response = await new Promise<number>((resolve, reject) => {
    const socket = tcpConnect(h.port, "127.0.0.1");
    let headers = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("timed out waiting for early oversized response"));
    }, 2000);
    socket.on("connect", () => {
      socket.write(
        [
          "PUT /jobs/job/parts/0/0 HTTP/1.1",
          "Host: 127.0.0.1",
          `Content-Length: ${declaredLength}`,
          `x-content-sha256: ${"0".repeat(64)}`,
          "Connection: close",
          "",
          "",
        ].join("\r\n")
      );
    });
    socket.on("data", (chunk) => {
      headers += chunk.toString();
      const firstLine = headers.match(httpStatusPattern);
      if (firstLine) {
        clearTimeout(timer);
        socket.destroy();
        resolve(Number(firstLine[1]));
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  expect(response).toBe(413);
  expect((await finalize(h)).status).toBe(409);
});

it("rejects missing parts and byte-concatenates timeslices before remux", async () => {
  const h = await harness();
  const missing = await h.request(
    "POST",
    "/jobs/job/finalize",
    JSON.stringify({
      outputMediaType: "video/webm",
      segments: [{ partIndexes: [0], segmentIndex: 0 }],
    }),
    { "content-type": "application/json" }
  );
  expect(missing.status).toBe(409);
  for (const [index, value] of ["a", "b"].entries()) {
    const bytes = Buffer.from(value);
    // biome-ignore lint/performance/noAwaitInLoops: ordered uploads model timeslice arrival.
    const response = await h.request(
      "PUT",
      `/jobs/job/parts/0/${index}`,
      bytes,
      { "x-content-sha256": sha(bytes) }
    );
    expect(response.status).toBe(201);
  }
  expect(
    (
      await h.request(
        "POST",
        "/jobs/job/finalize",
        JSON.stringify({
          outputMediaType: "video/webm",
          segments: [{ partIndexes: [0, 1], segmentIndex: 0 }],
        }),
        { "content-type": "application/json" }
      )
    ).status
  ).toBe(200);
  expect((await h.request("GET", "/jobs/job/output")).body).toEqual(
    Buffer.from("ab")
  );
});

it("preserves finalize, output, cleanup, and plan validation statuses", async () => {
  const h = await harness();
  expect((await h.request("GET", "/jobs/job/output")).status).toBe(404);
  expect(
    (
      await h.request(
        "POST",
        "/jobs/job/finalize",
        JSON.stringify({ outputMediaType: "video/webm", segments: [] }),
        { "content-type": "application/json" }
      )
    ).status
  ).toBe(400);
  expect(
    (
      await h.request(
        "POST",
        "/jobs/job/finalize",
        JSON.stringify({
          outputMediaType: "video/webm",
          segments: [{ partIndexes: [0], segmentIndex: 1 }],
        }),
        { "content-type": "application/json" }
      )
    ).status
  ).toBe(400);
  expect((await h.request("DELETE", "/jobs/job")).status).toBe(204);
  expect((await h.request("DELETE", "/jobs/job")).status).toBe(204);
});

it("publishes finalized output with protocol metadata", async () => {
  const h = await harness();
  const part = Buffer.from("media");
  expect(
    (
      await h.request("PUT", "/jobs/job/parts/0/0", part, {
        "x-content-sha256": sha(part),
      })
    ).status
  ).toBe(201);
  const finalized = await h.request(
    "POST",
    "/jobs/job/finalize",
    JSON.stringify({
      outputMediaType: "video/webm",
      segments: [{ partIndexes: [0], segmentIndex: 0 }],
    }),
    { "content-type": "application/json" }
  );
  expect(finalized.status).toBe(200);
  const output = await h.request("GET", "/jobs/job/output");
  expect(output.status).toBe(200);
  expect(output.headers["content-type"]).toContain("video/webm");
  expect(output.headers["content-length"]).toBe(String(part.length));
  expect(output.headers["x-content-sha256"]).toBe(sha(part));
});

it("keeps failed finalization output unavailable with 409", async () => {
  const h = await harness(true);
  const part = Buffer.from("media");
  await h.request("PUT", "/jobs/job/parts/0/0", part, {
    "x-content-sha256": sha(part),
  });
  const result = await h.request(
    "POST",
    "/jobs/job/finalize",
    JSON.stringify({
      outputMediaType: "video/webm",
      segments: [{ partIndexes: [0], segmentIndex: 0 }],
    }),
    { "content-type": "application/json" }
  );
  expect(result.status).toBe(422);
  expect((await h.request("GET", "/jobs/job/output")).status).toBe(409);
});

it("seals a job during deferred finalization", async () => {
  let release!: () => void;
  const deferred = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await harness(false, deferred);
  const part = Buffer.from("media");
  expect((await upload(h, 0, 0, part)).status).toBe(201);
  const first = finalize(h);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect((await finalize(h)).status).toBe(409);
  expect((await upload(h, 0, 1, Buffer.from("later"))).status).toBe(409);
  release();
  expect((await first).status).toBe(200);
});

it("rejects an overlapping finalize without a startup sleep", async () => {
  let release!: () => void;
  const deferred = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await harness(false, deferred);
  const part = Buffer.from("media");
  expect((await upload(h, 0, 0, part)).status).toBe(201);
  const first = finalize(h);
  const secondStatus = await Promise.race([
    finalize(h).then((result) => result.status),
    first.then((result) => {
      throw new Error(`first finalize finished first: ${result.status}`);
    }),
  ]);
  expect(secondStatus).toBe(409);
  expect((await upload(h, 0, 1, Buffer.from("later"))).status).toBe(409);
  release();
  expect((await first).status).toBe(200);
});

it("boots the CJS bundle without a dynamic require crash", async () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const bundle = path.join(root, "../output/server.cjs");
  await new Promise<void>((resolve, reject) => {
    const build = spawn("pnpm", ["build:server"], {
      cwd: path.join(root, ".."),
      stdio: "inherit",
    });
    build.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`build:server exited ${code}`))
    );
  });
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        reject(new Error("probe did not bind"));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
  const child = spawn("node", [bundle], {
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => {
        clearInterval(timer);
        reject(error);
      };
      child.once("exit", (code) =>
        fail(
          new Error(
            `bundle exited ${code}: ${Buffer.concat(stderr).toString()}`
          )
        )
      );
      const timer = setInterval(() => {
        const socket = tcpConnect({ host: "127.0.0.1", port }, () => {
          socket.end();
          clearInterval(timer);
          resolve();
        });
        socket.on("error", () => undefined);
      }, 50);
      setTimeout(
        () =>
          fail(new Error(Buffer.concat(stderr).toString() || "boot timeout")),
        5000
      );
    });
    const health = await new Promise<Response>((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", method: "GET", path: "/health", port },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            resolve({
              body: Buffer.concat(chunks),
              headers: response.headers,
              status: response.statusCode ?? 0,
            })
          );
        }
      );
      req.on("error", reject);
      req.end();
    });
    expect(health.status).toBe(204);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
});
