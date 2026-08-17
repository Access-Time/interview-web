import { expect, it } from "@effect/vitest";
import { vi } from "vitest";

vi.mock("@cloudflare/containers", () => ({
  Container: class {},
  getContainer: vi.fn(),
}));

import { Effect } from "effect";
import { ContainerClient } from "../src/worker/container.ts";
import { makePassthroughContainerClient } from "../src/worker/passthrough.ts";

const sha256 = async (bytes: Uint8Array) => {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
};

const read = async (body: ReadableStream<Uint8Array>) =>
  new Uint8Array(await new Response(body).arrayBuffer());

it.effect("concatenates parts in segment and sequence order", () =>
  Effect.gen(function* () {
    const client = yield* ContainerClient;
    yield* client.putPart({
      body: new Uint8Array([3]),
      checksum: "c".repeat(64),
      job: "job",
      segment: 1,
      sequence: 0,
    });
    yield* client.putPart({
      body: new Uint8Array([1, 2]),
      checksum: "a".repeat(64),
      job: "job",
      segment: 0,
      sequence: 0,
    });
    yield* client.putPart({
      body: new Uint8Array([4, 5]),
      checksum: "b".repeat(64),
      job: "job",
      segment: 1,
      sequence: 1,
    });
    yield* client.finalize({
      job: "job",
      outputMediaType: "video/webm",
      segments: [
        { partIndexes: [0], segmentIndex: 0 },
        { partIndexes: [0, 1], segmentIndex: 1 },
      ],
    });
    const output = yield* client.getOutput("job");
    const bytes = yield* Effect.promise(() => read(output.body));
    const checksum = yield* Effect.promise(() => sha256(bytes));
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4, 5]);
    expect(output.size).toBe(5);
    expect(output.mediaType).toBe("video/webm");
    expect(output.checksum).toBe(checksum);
  }).pipe(Effect.provide(makePassthroughContainerClient()))
);

it.effect("rejects a finalize plan that does not match uploaded parts", () =>
  Effect.gen(function* () {
    const client = yield* ContainerClient;
    yield* client.putPart({
      body: new Uint8Array([1]),
      checksum: "a".repeat(64),
      job: "job",
      segment: 0,
      sequence: 0,
    });
    const result = yield* client
      .finalize({
        job: "job",
        outputMediaType: "video/webm",
        segments: [{ partIndexes: [0, 1], segmentIndex: 0 }],
      })
      .pipe(Effect.flip);
    expect(result._tag).toBe("ContainerRejected");
  }).pipe(Effect.provide(makePassthroughContainerClient()))
);

it.effect("getOutput fails before finalize and after deleteJob", () =>
  Effect.gen(function* () {
    const client = yield* ContainerClient;
    const missing = yield* client.getOutput("job").pipe(Effect.flip);
    expect(missing._tag).toBe("InvalidContainerOutput");
    yield* client.putPart({
      body: new Uint8Array([1]),
      checksum: "a".repeat(64),
      job: "job",
      segment: 0,
      sequence: 0,
    });
    yield* client.finalize({
      job: "job",
      outputMediaType: "video/mp4",
      segments: [{ partIndexes: [0], segmentIndex: 0 }],
    });
    yield* client.deleteJob("job");
    const deleted = yield* client.getOutput("job").pipe(Effect.flip);
    expect(deleted._tag).toBe("InvalidContainerOutput");
  }).pipe(Effect.provide(makePassthroughContainerClient()))
);
