import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
} from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
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
  request: (
    method: string,
    route: string,
    body?: Buffer | string,
    headers?: Record<string, string>
  ) => Promise<Response>;
}
const harnesses: Harness[] = [];
const sha = (body: Buffer) => createHash("sha256").update(body).digest("hex");

async function harness(failFfmpeg = false): Promise<Harness> {
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
    request,
  };
  harnesses.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((value) => value.close()));
});

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
