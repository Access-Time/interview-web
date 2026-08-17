import { spawn } from "node:child_process";
import { Effect, Layer } from "effect";
import { FfmpegFailed, NoMediaStream } from "../domain/errors.ts";

type MediaType = "video/webm" | "video/mp4";
const profile = (type: MediaType) =>
  type === "video/webm"
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
const run = (program: string, args: string[], cwd: string) =>
  new Promise<{ code: number; stderr: string; stdout: string }>(
    (resolve, reject) => {
      const child = spawn(program, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5000).unref();
      }, 120_000);
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk).slice(
          0,
          Math.max(0, 1024 * 1024 - stdout.length)
        );
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk).slice(
          0,
          Math.max(0, 1024 * 1024 - stderr.length)
        );
      });
      child.once("error", reject);
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({ code: killed ? 124 : (code ?? 1), stderr, stdout });
      });
    }
  );
const command = (program: string, args: string[], cwd: string) =>
  Effect.tryPromise({
    catch: (error) =>
      new FfmpegFailed({ message: `${program} failed`, stderr: String(error) }),
    try: async () => {
      const result = await run(program, args, cwd);
      if (result.code !== 0) {
        throw new FfmpegFailed({
          message: `${program} failed`,
          stderr: result.stderr,
        });
      }
      return result;
    },
  });

const makeFfmpeg = () => ({
  concat: (input: {
    cwd: string;
    listPath: string;
    outputPath: string;
    mediaType: MediaType;
  }) =>
    command(
      "ffmpeg",
      [
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        input.listPath,
        ...profile(input.mediaType),
        "-f",
        input.mediaType === "video/webm" ? "webm" : "mp4",
        input.outputPath,
      ],
      input.cwd
    ).pipe(Effect.asVoid),
  probe: (input: { cwd: string; file: string }) =>
    command(
      "ffprobe",
      ["-v", "error", "-show_streams", "-of", "json", input.file],
      input.cwd
    ).pipe(
      Effect.flatMap((result) =>
        Effect.try({
          catch: () => new FfmpegFailed({ message: "invalid ffprobe output" }),
          try: () =>
            JSON.parse(result.stdout) as {
              streams?: Array<{ codec_type?: string }>;
            },
        })
      ),
      Effect.filterOrFail(
        (result) =>
          result.streams?.some(
            (stream) =>
              stream.codec_type === "audio" || stream.codec_type === "video"
          ) === true,
        () => new NoMediaStream({ message: "no media stream" })
      ),
      Effect.asVoid
    ),
  remux: (input: {
    cwd: string;
    inputPath: string;
    outputPath: string;
    mediaType: MediaType;
  }) =>
    command(
      "ffmpeg",
      [
        "-y",
        "-i",
        input.inputPath,
        ...profile(input.mediaType),
        "-f",
        input.mediaType === "video/webm" ? "webm" : "mp4",
        input.outputPath,
      ],
      input.cwd
    ).pipe(Effect.asVoid),
});

export class Ffmpeg extends Effect.Service<Ffmpeg>()("Ffmpeg", {
  accessors: true,
  effect: Effect.succeed(makeFfmpeg()),
}) {}
export const makeFfmpegTest = (
  impl: ReturnType<typeof makeFfmpeg>
): Layer.Layer<Ffmpeg> => Layer.succeed(Ffmpeg, impl as unknown as Ffmpeg);
export type FfmpegTest = ReturnType<typeof makeFfmpeg>;
