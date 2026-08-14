import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createFinalizerServer } from "./server.js";

const sha = (body) => crypto.createHash("sha256").update(body).digest("hex");
const FILE_PREFIX = /^file '/;
const FILE_SUFFIX = /'$/;
const harnesses = [];

afterEach(async () => {
  await Promise.all(
    harnesses.splice(0).map((serverHarness) => serverHarness.close())
  );
});
async function harness(
  run = async () => ({
    code: 0,
    stdout: JSON.stringify({ streams: [{ codec_type: "video" }] }),
  }),
  options = {}
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "finalizer-test-"));
  const server = createFinalizerServer({ root, run, ...options });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const request = (method, route, body, headers = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { headers, method, path: route, port },
        (res) => {
          const chunks = [];
          res.on("data", (b) => chunks.push(b));
          res.on("end", () =>
            resolve({
              body: Buffer.concat(chunks),
              headers: res.headers,
              status: res.statusCode,
            })
          );
        }
      );
      req.on("error", reject);
      if (body) {
        req.write(body);
      }
      req.end();
    });
  return {
    close: () => new Promise((resolve) => server.close(resolve)),
    request,
    root,
  };
}

function finalizeBody(segments = [{ partIndexes: [0], segmentIndex: 0 }]) {
  return JSON.stringify({ outputMediaType: "video/webm", segments });
}
function upload(h, segment, part, text, headers = {}) {
  const body = Buffer.from(text);
  return h.request("PUT", `/jobs/job/parts/${segment}/${part}`, body, {
    ...headers,
    "x-content-sha256": sha(body),
  });
}

it("parts accept checksummed content and exact repeats are idempotent", async () => {
  const h = await harness();
  harnesses.push(h);
  const body = Buffer.from("part");
  const headers = {
    "content-length": body.length,
    "x-content-sha256": sha(body),
  };
  expect(
    (await h.request("PUT", "/jobs/job/parts/0/0", body, headers)).status
  ).toEqual(201);
  expect(
    (await h.request("PUT", "/jobs/job/parts/0/0", body, headers)).status
  ).toEqual(200);
  expect(
    (
      await h.request("PUT", "/jobs/job/parts/0/0", Buffer.from("other"), {
        "x-content-sha256": sha("other"),
      })
    ).status
  ).toEqual(409);
});

it("finalize rejects missing parts and normalizes each segment before final concat", async () => {
  const calls = [];
  const h = await harness(async (program, args, options) => {
    calls.push([program, args]);
    if (program === "ffmpeg") {
      await fs.writeFile(path.join(options.cwd, args.at(-1)), "media");
    }
    return {
      code: 0,
      stdout: JSON.stringify({ streams: [{ codec_type: "video" }] }),
    };
  });
  harnesses.push(h);
  const missing = await h.request(
    "POST",
    "/jobs/job/finalize",
    JSON.stringify({
      outputMediaType: "video/webm",
      segments: [{ partIndexes: [9], segmentIndex: 0 }],
    }),
    { "content-type": "application/json" }
  );
  expect(missing.status).toEqual(409);
  for (const [partNumber, body] of [0, 1].map((value) => [
    value,
    Buffer.from(`p${value}`),
  ])) {
    // biome-ignore lint/performance/noAwaitInLoops: uploads are intentionally tested in order.
    const response = await h.request(
      "PUT",
      `/jobs/job/parts/${partNumber}/${partNumber}`,
      body,
      {
        "x-content-sha256": sha(body),
      }
    );
    expect(response.status).toEqual(201);
  }
  const done = await h.request(
    "POST",
    "/jobs/job/finalize",
    JSON.stringify({
      outputMediaType: "video/webm",
      segments: [
        { partIndexes: [0], segmentIndex: 0 },
        { partIndexes: [1], segmentIndex: 1 },
      ],
    }),
    { "content-type": "application/json" }
  );
  expect(done.status).toEqual(200);
  expect(calls.filter(([p]) => p === "ffmpeg").length).toEqual(3);
  expect((await h.request("GET", "/jobs/job/output")).status).toEqual(200);
});

it("reconstructs parts within segments but keeps segments separate", async () => {
  const inputs = [];
  const h = await harness(async (program, args, options) => {
    if (program === "ffmpeg") {
      const input = args[args.indexOf("-i") + 1];
      inputs.push({
        args,
        input,
        list: await fs.readFile(path.join(options.cwd, input), "utf8"),
      });
      await fs.writeFile(path.join(options.cwd, args.at(-1)), "media");
    }
    return {
      code: 0,
      stdout: JSON.stringify({ streams: [{ codec_type: "video" }] }),
    };
  });
  harnesses.push(h);
  expect((await upload(h, 0, 0, "a")).status).toEqual(201);
  expect((await upload(h, 0, 1, "b")).status).toEqual(201);
  expect((await upload(h, 1, 0, "c")).status).toEqual(201);
  expect(
    (
      await h.request(
        "POST",
        "/jobs/job/finalize",
        finalizeBody([
          { partIndexes: [0, 1], segmentIndex: 0 },
          { partIndexes: [0], segmentIndex: 1 },
        ]),
        { "content-type": "application/json" }
      )
    ).status
  ).toEqual(200);
  const segmentLists = inputs.slice(0, 2).map(({ list }) =>
    list
      .trim()
      .split("\n")
      .map((line) => line.replace(FILE_PREFIX, "").replace(FILE_SUFFIX, ""))
  );
  expect(
    await Promise.all(
      segmentLists.map((list) =>
        Promise.all(
          list.map((name) => fs.readFile(path.join(h.root, "job", name)))
        )
      )
    )
  ).toEqual([[Buffer.from("a"), Buffer.from("b")], [Buffer.from("c")]]);
  expect(
    inputs.every(({ args }) => args[args.indexOf("-f") + 1] === "concat")
  ).toBe(true);
  expect(inputs.every(({ input }) => input.endsWith(".txt"))).toBe(true);
  expect(inputs[0].input).not.toBe(inputs[1].input);
});

it("failed ffmpeg never exposes output", async () => {
  const h = await harness(async (program) => ({
    code: program === "ffmpeg" ? 1 : 0,
    stdout: JSON.stringify({ streams: [{ codec_type: "video" }] }),
  }));
  harnesses.push(h);
  const body = Buffer.from("p");
  await h.request("PUT", "/jobs/job/parts/0/0", body, {
    "x-content-sha256": sha(body),
  });
  const result = await h.request(
    "POST",
    "/jobs/job/finalize",
    JSON.stringify({
      outputMediaType: "video/mp4",
      segments: [{ partIndexes: [0], segmentIndex: 0 }],
    }),
    { "content-type": "application/json" }
  );
  expect(result.status).toEqual(422);
  expect((await h.request("GET", "/jobs/job/output")).status).toEqual(409);
});

it("private binding allows health and job routes without authorization", async () => {
  const h = await harness();
  harnesses.push(h);
  expect((await h.request("GET", "/health")).status).toEqual(204);
  const body = Buffer.from("x");
  expect((await upload(h, 0, 0, body)).status).toEqual(201);
});

it("concurrent finalization permits exactly one runner", async () => {
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const h = await harness(async (program, args, options) => {
    if (program === "ffmpeg") {
      await blocked;
      await fs.writeFile(path.join(options.cwd, args.at(-1)), "media");
    }
    return {
      code: 0,
      stdout: JSON.stringify({ streams: [{ codec_type: "video" }] }),
    };
  });
  harnesses.push(h);
  expect((await upload(h, 0, 0, "x")).status).toEqual(201);
  const body = finalizeBody();
  const first = h.request("POST", "/jobs/job/finalize", body, {
    "content-type": "application/json",
  });
  await new Promise((r) => setTimeout(r, 10));
  expect(
    (
      await h.request("POST", "/jobs/job/finalize", body, {
        "content-type": "application/json",
      })
    ).status
  ).toEqual(409);
  release();
  expect((await first).status).toEqual(200);
});

it("finalize plan is exact and segment-aware", async () => {
  const h = await harness(async (program, args, options) => {
    if (program === "ffmpeg") {
      await fs.writeFile(path.join(options.cwd, args.at(-1)), "media");
    }
    return {
      code: 0,
      stdout: JSON.stringify({ streams: [{ codec_type: "video" }] }),
    };
  });
  harnesses.push(h);
  expect((await upload(h, 0, 0, "a")).status).toEqual(201);
  expect((await upload(h, 1, 0, "b")).status).toEqual(201);
  const duplicate = await h.request(
    "POST",
    "/jobs/job/finalize",
    finalizeBody([
      { partIndexes: [0, 0], segmentIndex: 0 },
      { partIndexes: [0], segmentIndex: 1 },
    ]),
    { "content-type": "application/json" }
  );
  expect(duplicate.status).toEqual(400);
  const omitted = await h.request(
    "POST",
    "/jobs/job/finalize",
    finalizeBody([{ partIndexes: [0], segmentIndex: 0 }]),
    { "content-type": "application/json" }
  );
  expect(omitted.status).toEqual(409);
  const accepted = await h.request(
    "POST",
    "/jobs/job/finalize",
    finalizeBody([
      { partIndexes: [0], segmentIndex: 0 },
      { partIndexes: [0], segmentIndex: 1 },
    ]),
    { "content-type": "application/json" }
  );
  expect(accepted.status).toEqual(200);
});

it("upload racing sealing is rejected and leaves no temporary file", async () => {
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const h = await harness(async (program, args, options) => {
    if (program === "ffmpeg") {
      await blocked;
      await fs.writeFile(path.join(options.cwd, args.at(-1)), "x");
    }
    return {
      code: 0,
      stdout: JSON.stringify({ streams: [{ codec_type: "video" }] }),
    };
  });
  harnesses.push(h);
  expect((await upload(h, 0, 0, "a")).status).toEqual(201);
  const finalizing = h.request("POST", "/jobs/job/finalize", finalizeBody(), {
    "content-type": "application/json",
  });
  await new Promise((r) => setTimeout(r, 10));
  expect((await upload(h, 0, 1, "b")).status).toEqual(409);
  release();
  await finalizing;
  expect(
    (await fs.readdir(path.join(h.root, "job"))).filter((name) =>
      name.startsWith(".upload-")
    ).length
  ).toEqual(0);
});

it("part byte limit returns 413 without accepting the part", async () => {
  const h = await harness(undefined, { maxPartBytes: 2 });
  harnesses.push(h);
  const body = Buffer.from("abc");
  expect((await upload(h, 0, 0, body)).status).toEqual(413);
  expect(
    (
      await h.request("POST", "/jobs/job/finalize", finalizeBody(), {
        "content-type": "application/json",
      })
    ).status
  ).toEqual(409);
});

it("DELETE cleanup is idempotent and removes output", async () => {
  const h = await harness();
  harnesses.push(h);
  expect((await h.request("DELETE", "/jobs/job")).status).toEqual(204);
  expect((await h.request("DELETE", "/jobs/job")).status).toEqual(204);
  expect((await h.request("GET", "/jobs/job/output")).status).toEqual(404);
});

it("missing output cannot produce a successful complete response", async () => {
  const h = await harness(async (program, args, options) => {
    if (program === "ffmpeg") {
      await fs.writeFile(path.join(options.cwd, args.at(-1)), "media");
    }
    return {
      code: 0,
      stdout: JSON.stringify({ streams: [{ codec_type: "video" }] }),
    };
  });
  harnesses.push(h);
  expect((await upload(h, 0, 0, "x")).status).toEqual(201);
  expect(
    (
      await h.request("POST", "/jobs/job/finalize", finalizeBody(), {
        "content-type": "application/json",
      })
    ).status
  ).toEqual(200);
  await fs.rm(path.join(h.root, "job"), { recursive: true });
  const response = await h.request("GET", "/jobs/job/output");
  expect(response.status).not.toBe(200);
});
