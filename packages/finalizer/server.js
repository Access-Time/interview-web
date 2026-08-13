import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const JOB = /^[A-Za-z0-9_-]{1,128}$/;
const NUM = /^(0|[1-9][0-9]*)$/;
const CHECKSUM = /^[a-f\d]{64}$/i;
const DELETE_JOB = /^\/jobs\/([^/]+)$/;
const JOB_ROUTE =
  /^\/jobs\/([^/]+)(?:\/parts\/([^/]+)\/([^/]+)|\/(finalize|output))$/;
const TYPES = new Set(["video/webm", "video/mp4"]);
const fail = (status, message) => Object.assign(new Error(message), { status });

export function defaultRun(
  program,
  args,
  { cwd, timeoutMs = 120_000, outputLimit = 1024 * 1024 } = {}
) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      killed = false;
    child.stdout.on("data", (b) => {
      stdout += b.toString().slice(0, Math.max(0, outputLimit - stdout.length));
    });
    child.stderr.on("data", (b) => {
      stderr += b.toString().slice(0, Math.max(0, outputLimit - stderr.length));
    });
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutMs);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, killed, signal, stderr, stdout });
    });
  });
}

function json(res, status, value) {
  const b = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    "content-length": b.length,
    "content-type": "application/json",
  });
  res.end(b);
}
async function parseJson(req, limit) {
  let b = 0,
    chunks = [];
  for await (const chunk of req) {
    b += chunk.length;
    if (b > limit) {
      throw fail(413, "JSON request too large");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch (error) {
    throw Object.assign(fail(400, "invalid JSON"), { cause: error });
  }
}
function number(value) {
  if (!NUM.test(value)) {
    throw fail(400, "invalid part number");
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw fail(400, "invalid part number");
  }
  return n;
}
function ext(type) {
  return type === "video/webm" ? "webm" : "mp4";
}
function profile(type) {
  return type === "video/webm"
    ? ["-c:v", "libvpx-vp9", "-c:a", "libopus", "-deadline", "good"]
    : [
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
      ];
}

async function streamPart(req, temp, maxBytes, expected) {
  const out = fs.createWriteStream(temp, { flags: "wx" });
  const hash = crypto.createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBytes) {
        throw fail(413, "part too large");
      }
      hash.update(chunk);
      if (!out.write(chunk)) {
        await new Promise((r, j) => {
          out.once("drain", r);
          out.once("error", j);
        });
      }
    }
    await new Promise((r, j) => {
      out.end(r);
      out.once("error", j);
    });
    if (expected !== null && size !== expected) {
      throw fail(400, "content length mismatch");
    }
    return { hash: hash.digest("hex"), size };
  } catch (e) {
    out.destroy();
    await fsp.rm(temp, { force: true });
    throw e;
  }
}

export function createFinalizerServer({
  root = path.join(os.tmpdir(), "recording-finalizer"),
  run = defaultRun,
  token,
  maxPartBytes = 512 * 1024 * 1024,
  maxJobBytes = 2 * 1024 * 1024 * 1024,
  maxJsonBytes = 2 * 1024 * 1024,
  timeoutMs = 120_000,
  outputLimit = 1024 * 1024,
} = {}) {
  const jobs = new Map();
  const stateFor = (id) => {
    let s = jobs.get(id);
    if (!s) {
      s = { bytes: 0, output: null, parts: new Map(), status: "open" };
      jobs.set(id, s);
    }
    return s;
  };
  const invoke = async (program, args, cwd) => {
    const r = await run(program, args, { cwd, outputLimit, timeoutMs });
    if (r?.code !== 0) {
      throw fail(422, `${program} failed`);
    }
    return r;
  };
  const probe = async (file, cwd) => {
    let r = await invoke(
        "ffprobe",
        ["-v", "error", "-show_streams", "-of", "json", file],
        cwd
      ),
      p;
    try {
      p = JSON.parse(r.stdout);
    } catch (error) {
      throw Object.assign(fail(422, "invalid ffprobe output"), {
        cause: error,
      });
    }
    if (
      !p.streams?.some(
        (x) => x.codec_type === "audio" || x.codec_type === "video"
      )
    ) {
      throw fail(422, "no media stream");
    }
  };
  const cleanupIntermediates = async (dir, parts) => {
    for (const name of await fsp.readdir(dir).catch(() => [])) {
      if (!parts.has(name)) {
        // biome-ignore lint/performance/noAwaitInLoops: intermediates are removed serially to avoid racing active filesystem work.
        await fsp.rm(path.join(dir, name), { force: true, recursive: true });
      }
    }
  };

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: ordered protocol validation and FFmpeg execution.
  async function finalize(req, state, dir) {
    const data = await parseJson(req, maxJsonBytes);
    if (state.status !== "open") {
      throw fail(409, "job is not open");
    }
    if (
      !(data && Array.isArray(data.segments) && data.segments.length) ||
      data.segments.length > 20 ||
      !TYPES.has(data.outputMediaType)
    ) {
      throw fail(400, "invalid finalize request");
    }
    const requested = new Set();
    for (const [si, segment] of data.segments.entries()) {
      if (
        !(segment && Number.isSafeInteger(segment.segmentIndex)) ||
        segment.segmentIndex !== si ||
        !Array.isArray(segment.partIndexes) ||
        !segment.partIndexes.length ||
        segment.partIndexes.length > 10_000
      ) {
        throw fail(400, "invalid or duplicate segment parts");
      }
      for (const part of segment.partIndexes) {
        const key = `${si}:${part}`;
        if (!Number.isSafeInteger(part) || part < 0 || requested.has(key)) {
          throw fail(400, "invalid or duplicate segment parts");
        }
        requested.add(key);
      }
    }
    const uploaded = new Set(state.parts.keys());
    if (
      uploaded.size !== requested.size ||
      [...uploaded].some((k) => !requested.has(k))
    ) {
      throw fail(409, "uploaded parts do not exactly match finalize plan");
    }
    state.status = "sealing";
    try {
      const runId = crypto.randomUUID(),
        normalized = [],
        format = ext(data.outputMediaType);
      for (let i = 0; i < data.segments.length; i += 1) {
        const list = `run-${runId}-segment-${i}-parts.txt`,
          output = `run-${runId}-segment-${i}.${format}`;
        // biome-ignore lint/performance/noAwaitInLoops: segments must normalize serially because media state is reused between steps.
        await fsp.writeFile(
          path.join(dir, list),
          `${data.segments[i].partIndexes
            .map((part) => `file '${state.parts.get(`${i}:${part}`).filename}'`)
            .join("\n")}\n`
        );
        await invoke(
          "ffmpeg",
          [
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            list,
            ...profile(data.outputMediaType),
            "-f",
            format,
            output,
          ],
          dir
        );
        await probe(output, dir);
        normalized.push(output);
      }
      const list = `run-${runId}-final.txt`,
        output = `run-${runId}-final.${format}`;
      await fsp.writeFile(
        path.join(dir, list),
        `${normalized.map((n) => `file '${n}'`).join("\n")}\n`
      );
      await invoke(
        "ffmpeg",
        [
          "-y",
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          list,
          ...profile(data.outputMediaType),
          "-f",
          format,
          output,
        ],
        dir
      );
      await probe(output, dir);
      const stat = await fsp.stat(path.join(dir, output));
      const h = crypto.createHash("sha256");
      await pipeline(fs.createReadStream(path.join(dir, output)), h); // hash stream completion is sufficient for the file already stat'ed
      state.output = {
        filename: output,
        hash: h.digest("hex"),
        size: stat.size,
        type: data.outputMediaType,
      };
      state.status = "done";
    } catch (e) {
      state.output = null;
      state.status = "failed";
      await cleanupIntermediates(
        dir,
        new Set([...state.parts.values()].map((p) => p.filename))
      );
      throw e;
    }
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: single HTTP protocol dispatcher.
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(204);
        return res.end();
      }
      if (
        token !== undefined &&
        req.headers.authorization !== `Bearer ${token}`
      ) {
        throw fail(401, "unauthorized");
      }
      const u = new URL(req.url, "http://localhost");
      const deleteMatch = u.pathname.match(DELETE_JOB);
      const m = u.pathname.match(JOB_ROUTE);
      if (
        !(
          (m || deleteMatch) &&
          JOB.test(decodeURIComponent((m || deleteMatch)[1]))
        )
      ) {
        throw fail(404, "not found");
      }
      const id = decodeURIComponent((m || deleteMatch)[1]),
        dir = path.join(root, id),
        state = stateFor(id);
      if (req.method === "DELETE" && deleteMatch) {
        await fsp.rm(dir, { force: true, recursive: true });
        jobs.delete(id);
        res.writeHead(204);
        return res.end();
      }
      if (req.method === "PUT" && m[2]) {
        if (state.status !== "open") {
          throw fail(409, "job is not open");
        }
        const key = `${number(m[2])}:${number(m[3])}`,
          checksum = req.headers["x-content-sha256"];
        if (typeof checksum !== "string" || !CHECKSUM.test(checksum)) {
          throw fail(400, "invalid checksum");
        }
        const length =
          req.headers["content-length"] === undefined
            ? null
            : Number(req.headers["content-length"]);
        if (length !== null && (!Number.isSafeInteger(length) || length < 0)) {
          throw fail(400, "invalid content length");
        }
        const temp = path.join(dir, `.upload-${crypto.randomUUID()}`);
        await fsp.mkdir(dir, { recursive: true });
        const got = await streamPart(
          req,
          temp,
          Math.min(maxPartBytes, maxJobBytes - state.bytes),
          length
        );
        if (got.hash !== checksum.toLowerCase()) {
          await fsp.rm(temp, { force: true });
          throw fail(400, "checksum mismatch");
        }
        if (state.status !== "open") {
          await fsp.rm(temp, { force: true });
          throw fail(409, "job is sealing");
        }
        const old = state.parts.get(key);
        if (old) {
          await fsp.rm(temp, { force: true });
          if (old.hash !== got.hash || old.size !== got.size) {
            throw fail(409, "part already differs");
          }
          return json(res, 200, { idempotent: true });
        }
        if (state.bytes + got.size > maxJobBytes) {
          await fsp.rm(temp, { force: true });
          throw fail(413, "job too large");
        }
        const filename = `part-${crypto.randomUUID()}.bin`;
        await fsp.rename(temp, path.join(dir, filename));
        state.parts.set(key, { filename, hash: got.hash, size: got.size });
        state.bytes += got.size;
        return json(res, 201, { accepted: true });
      }
      if (req.method === "POST" && m[4] === "finalize") {
        if (state.status !== "open") {
          throw fail(409, "job is not open");
        }
        await finalize(req, state, dir);
        return json(res, 200, { finalized: true });
      }
      if (req.method === "GET" && m[4] === "output") {
        if (state.status === "sealing") {
          throw fail(409, "finalization in progress");
        }
        if (state.status !== "done") {
          throw fail(
            state.status === "failed" ? 409 : 404,
            "output unavailable"
          );
        }
        const o = state.output;
        await fsp.access(path.join(dir, o.filename));
        res.writeHead(200, {
          "content-length": o.size,
          "content-type": o.type,
          "x-content-sha256": o.hash,
        });
        await pipeline(fs.createReadStream(path.join(dir, o.filename)), res);
        return;
      }
      throw fail(405, "method not allowed");
    } catch (e) {
      if (res.headersSent) {
        res.destroy();
      } else {
        json(res, e.status || 500, { error: e.message || "internal error" });
      }
    }
  });
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.env.FINALIZER_TOKEN) {
    throw new Error("FINALIZER_TOKEN is required");
  }
  createFinalizerServer({ token: process.env.FINALIZER_TOKEN }).listen(
    Number(process.env.PORT) || 8080
  );
}
