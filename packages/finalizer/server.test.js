import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFinalizerServer } from "./server.js";

const sha = (body) => crypto.createHash("sha256").update(body).digest("hex");
const FILE_PREFIX = /^file '/;
const FILE_SUFFIX = /'$/;
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
function auth(token) {
  return token ? { authorization: `Bearer ${token}` } : {};
}
function upload(h, segment, part, text, headers = {}) {
  const body = Buffer.from(text);
  return h.request("PUT", `/jobs/job/parts/${segment}/${part}`, body, {
    ...headers,
    "x-content-sha256": sha(body),
    ...auth(headers.token),
  });
}

test("parts accept checksummed content and exact repeats are idempotent", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const body = Buffer.from("part");
  const headers = {
    "content-length": body.length,
    "x-content-sha256": sha(body),
  };
  assert.equal(
    (await h.request("PUT", "/jobs/job/parts/0/0", body, headers)).status,
    201
  );
  assert.equal(
    (await h.request("PUT", "/jobs/job/parts/0/0", body, headers)).status,
    200
  );
  assert.equal(
    (
      await h.request("PUT", "/jobs/job/parts/0/0", Buffer.from("other"), {
        "x-content-sha256": sha("other"),
      })
    ).status,
    409
  );
});

test("finalize rejects missing parts and normalizes each segment before final concat", async (t) => {
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
  t.after(() => h.close());
  const missing = await h.request(
    "POST",
    "/jobs/job/finalize",
    JSON.stringify({
      outputMediaType: "video/webm",
      segments: [{ partIndexes: [9], segmentIndex: 0 }],
    }),
    { "content-type": "application/json" }
  );
  assert.equal(missing.status, 409);
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
    assert.equal(response.status, 201);
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
  assert.equal(done.status, 200);
  assert.equal(calls.filter(([p]) => p === "ffmpeg").length, 3);
  assert.equal((await h.request("GET", "/jobs/job/output")).status, 200);
});

test("reconstructs parts within segments but keeps segments separate", async (t) => {
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
  t.after(() => h.close());
  assert.equal((await upload(h, 0, 0, "a")).status, 201);
  assert.equal((await upload(h, 0, 1, "b")).status, 201);
  assert.equal((await upload(h, 1, 0, "c")).status, 201);
  assert.equal(
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
    ).status,
    200
  );
  const segmentLists = inputs.slice(0, 2).map(({ list }) =>
    list
      .trim()
      .split("\n")
      .map((line) => line.replace(FILE_PREFIX, "").replace(FILE_SUFFIX, ""))
  );
  assert.deepEqual(
    await Promise.all(
      segmentLists.map((list) =>
        Promise.all(
          list.map((name) => fs.readFile(path.join(h.root, "job", name)))
        )
      )
    ),
    [[Buffer.from("a"), Buffer.from("b")], [Buffer.from("c")]]
  );
  assert.ok(
    inputs.every(({ args }) => args[args.indexOf("-f") + 1] === "concat")
  );
  assert.ok(inputs.every(({ input }) => input.endsWith(".txt")));
  assert.notEqual(inputs[0].input, inputs[1].input);
});

test("failed ffmpeg never exposes output", async (t) => {
  const h = await harness(async (program) => ({
    code: program === "ffmpeg" ? 1 : 0,
    stdout: JSON.stringify({ streams: [{ codec_type: "video" }] }),
  }));
  t.after(() => h.close());
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
  assert.equal(result.status, 422);
  assert.equal((await h.request("GET", "/jobs/job/output")).status, 409);
});

test("explicit token rejects missing and wrong credentials", async (t) => {
  const h = await harness(undefined, { token: "secret" });
  t.after(() => h.close());
  const body = Buffer.from("x");
  const base = { "x-content-sha256": sha(body) };
  assert.equal(
    (await h.request("PUT", "/jobs/auth/parts/0/0", body, base)).status,
    401
  );
  assert.equal(
    (
      await h.request("PUT", "/jobs/auth/parts/0/0", body, {
        ...base,
        authorization: "Bearer wrong",
      })
    ).status,
    401
  );
  assert.equal(
    (
      await h.request("PUT", "/jobs/auth/parts/0/0", body, {
        ...base,
        authorization: "Bearer secret",
      })
    ).status,
    201
  );
});

test("health is public while job routes require the token", async (t) => {
  const h = await harness(undefined, { token: "secret" });
  t.after(() => h.close());
  assert.equal((await h.request("GET", "/health")).status, 204);
  assert.equal((await h.request("GET", "/jobs/job/output")).status, 401);
});

test("concurrent finalization permits exactly one runner", async (t) => {
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
  t.after(() => h.close());
  assert.equal((await upload(h, 0, 0, "x")).status, 201);
  const body = finalizeBody();
  const first = h.request("POST", "/jobs/job/finalize", body, {
    "content-type": "application/json",
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(
    (
      await h.request("POST", "/jobs/job/finalize", body, {
        "content-type": "application/json",
      })
    ).status,
    409
  );
  release();
  assert.equal((await first).status, 200);
});

test("finalize plan is exact and segment-aware", async (t) => {
  const h = await harness(async (program, args, options) => {
    if (program === "ffmpeg") {
      await fs.writeFile(path.join(options.cwd, args.at(-1)), "media");
    }
    return {
      code: 0,
      stdout: JSON.stringify({ streams: [{ codec_type: "video" }] }),
    };
  });
  t.after(() => h.close());
  assert.equal((await upload(h, 0, 0, "a")).status, 201);
  assert.equal((await upload(h, 1, 0, "b")).status, 201);
  const duplicate = await h.request(
    "POST",
    "/jobs/job/finalize",
    finalizeBody([
      { partIndexes: [0, 0], segmentIndex: 0 },
      { partIndexes: [0], segmentIndex: 1 },
    ]),
    { "content-type": "application/json" }
  );
  assert.equal(duplicate.status, 400);
  const omitted = await h.request(
    "POST",
    "/jobs/job/finalize",
    finalizeBody([{ partIndexes: [0], segmentIndex: 0 }]),
    { "content-type": "application/json" }
  );
  assert.equal(omitted.status, 409);
  const accepted = await h.request(
    "POST",
    "/jobs/job/finalize",
    finalizeBody([
      { partIndexes: [0], segmentIndex: 0 },
      { partIndexes: [0], segmentIndex: 1 },
    ]),
    { "content-type": "application/json" }
  );
  assert.equal(accepted.status, 200);
});

test("upload racing sealing is rejected and leaves no temporary file", async (t) => {
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
  t.after(() => h.close());
  assert.equal((await upload(h, 0, 0, "a")).status, 201);
  const finalizing = h.request("POST", "/jobs/job/finalize", finalizeBody(), {
    "content-type": "application/json",
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal((await upload(h, 0, 1, "b")).status, 409);
  release();
  await finalizing;
  assert.equal(
    (await fs.readdir(path.join(h.root, "job"))).filter((name) =>
      name.startsWith(".upload-")
    ).length,
    0
  );
});

test("part byte limit returns 413 without accepting the part", async (t) => {
  const h = await harness(undefined, { maxPartBytes: 2 });
  t.after(() => h.close());
  const body = Buffer.from("abc");
  assert.equal((await upload(h, 0, 0, body)).status, 413);
  assert.equal(
    (
      await h.request("POST", "/jobs/job/finalize", finalizeBody(), {
        "content-type": "application/json",
      })
    ).status,
    409
  );
});

test("DELETE cleanup is idempotent and removes output", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  assert.equal((await h.request("DELETE", "/jobs/job")).status, 204);
  assert.equal((await h.request("DELETE", "/jobs/job")).status, 204);
  assert.equal((await h.request("GET", "/jobs/job/output")).status, 404);
});

test("missing output cannot produce a successful complete response", async (t) => {
  const h = await harness(async (program, args, options) => {
    if (program === "ffmpeg") {
      await fs.writeFile(path.join(options.cwd, args.at(-1)), "media");
    }
    return {
      code: 0,
      stdout: JSON.stringify({ streams: [{ codec_type: "video" }] }),
    };
  });
  t.after(() => h.close());
  assert.equal((await upload(h, 0, 0, "x")).status, 201);
  assert.equal(
    (
      await h.request("POST", "/jobs/job/finalize", finalizeBody(), {
        "content-type": "application/json",
      })
    ).status,
    200
  );
  await fs.rm(path.join(h.root, "job"), { recursive: true });
  const response = await h.request("GET", "/jobs/job/output");
  assert.notEqual(response.status, 200);
});
