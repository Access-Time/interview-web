import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
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

async function harness(): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), "finalizer-test-"));
  const ffmpeg = {
    concat: () => Effect.succeed(undefined),
    probe: () => Effect.succeed(undefined),
    remux: () => Effect.succeed(undefined),
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
});
