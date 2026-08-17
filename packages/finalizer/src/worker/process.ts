import { Effect, Option, Schedule } from "effect";
import type { SessionId } from "../domain/brands.ts";
import {
  isTerminalFinalization,
  MissingOrCorruptPart,
  OutputPublicationMetadataMismatch,
  OutputPublicationNotProven,
} from "../domain/errors.ts";
import {
  deterministicJobName,
  isExactPublishedObject,
  outputMediaType,
} from "../domain/media.ts";
import { decodeFinalizePlan, decodeManifest } from "../domain/validate.ts";
import { ContainerClient } from "./container.ts";
import { FinalizerDb } from "./db.ts";
import { Recordings } from "./recordings.ts";

const retrySchedule = Schedule.recurs(3).pipe(
  Schedule.intersect(Schedule.exponential("200 millis")),
  Schedule.whileInput(
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      [
        "ContainerUnavailable",
        "OutputPublicationNotProven",
        "OutputSizeMismatch",
      ].includes(String(error._tag))
  )
);

const isExact = (
  meta:
    | {
        checksums?: { sha256?: string | ArrayBuffer | ArrayBufferView };
        httpMetadata?: { contentType?: string };
        size: number;
      }
    | null
    | undefined,
  expected: { checksum: string; mediaType: string; size: number }
) => isExactPublishedObject(meta, expected);

const runAttempt = (
  sessionId: SessionId,
  attempt: number,
  manifest: Parameters<typeof outputMediaType>[0]
) =>
  Effect.gen(function* () {
    const db = yield* FinalizerDb;
    const recordings = yield* Recordings;
    const container = yield* ContainerClient;
    const job = yield* Effect.promise(() =>
      deterministicJobName(sessionId, attempt)
    );
    const outputKey = `recordings/${encodeURIComponent(sessionId)}/finalizations/attempt-${attempt}/output.${outputMediaType(manifest) === "video/mp4" ? "mp4" : "webm"}`;

    yield* Effect.forkScoped(
      db
        .renew({ attempt, sessionId })
        .pipe(Effect.repeat(Schedule.fixed("60 seconds")))
    );
    for (const segment of manifest.segments) {
      for (const part of segment.parts) {
        const object = yield* recordings.get(part.objectKey);
        if (
          object.size !== part.byteSize ||
          object.checksum !== part.checksum
        ) {
          return yield* Effect.fail(
            new MissingOrCorruptPart({ message: "missing or corrupt part" })
          );
        }
        yield* container.putPart({
          body: object.body,
          checksum: part.checksum,
          job,
          segment: segment.index,
          sequence: part.sequence,
        });
      }
    }
    yield* container
      .finalize({
        job,
        outputMediaType: outputMediaType(manifest),
        segments: manifest.segments.map((segment) => ({
          partIndexes: segment.parts.map((part) => part.sequence),
          segmentIndex: segment.index,
        })),
      })
      .pipe(Effect.retry(retrySchedule));
    const output = yield* container
      .getOutput(job)
      .pipe(Effect.retry(retrySchedule));
    const expected = {
      checksum: output.checksum,
      mediaType: output.mediaType,
      size: output.size,
    };
    const published = yield* Effect.gen(function* () {
      const written = yield* recordings.put(outputKey, output.body, {
        httpMetadata: { contentType: output.mediaType },
        onlyIf: { etagDoesNotMatch: "*" },
        sha256: output.checksum,
      });
      if (Option.isNone(written)) {
        const head = yield* recordings.head(outputKey);
        if (!isExact(Option.getOrUndefined(head), expected)) {
          return yield* Effect.fail(
            new OutputPublicationNotProven({
              message: "output publication not proven",
            })
          );
        }
        return false;
      }
      if (!isExact(written.value, expected)) {
        return yield* Effect.fail(
          new OutputPublicationMetadataMismatch({
            message: "output publication metadata mismatch",
          })
        );
      }
      return true;
    }).pipe(Effect.retry(retrySchedule));
    yield* db.complete({
      attempt,
      output: {
        byteSize: expected.size,
        checksum: expected.checksum as never,
        mediaType: expected.mediaType,
        objectKey: outputKey,
      },
      sessionId,
    });
    yield* Effect.addFinalizer(() =>
      container.deleteJob(job).pipe(Effect.orDie)
    );
    return { outputKey, published };
  });

export const processFinalization = Effect.fn("processFinalization")(function* (
  sessionId: SessionId
) {
  const db = yield* FinalizerDb;
  const recordings = yield* Recordings;
  const claimed = yield* db.claim(sessionId);
  if (Option.isNone(claimed)) {
    return;
  }
  const job = claimed.value;
  const result = yield* Effect.gen(function* () {
    const manifest = yield* decodeManifest(job.manifest);
    yield* decodeFinalizePlan(manifest, job.finalizePlan);
    const outputKey = `recordings/${encodeURIComponent(sessionId)}/finalizations/attempt-${job.attempt}/output.${outputMediaType(manifest as never) === "video/mp4" ? "mp4" : "webm"}`;
    return yield* runAttempt(sessionId, job.attempt, manifest as never).pipe(
      Effect.scoped,
      Effect.tapError(() =>
        db.ready(sessionId).pipe(
          Effect.flatMap((ready) =>
            Option.isSome(ready) && ready.value.objectKey === outputKey
              ? Effect.void
              : recordings.delete(outputKey)
          ),
          Effect.orDie
        )
      )
    );
  }).pipe(
    Effect.catchIf(isTerminalFinalization, (error) =>
      db
        .fail({ attempt: job.attempt, failureCode: error._tag, sessionId })
        .pipe(Effect.asVoid)
    ),
    Effect.tapError((error) =>
      isTerminalFinalization(error)
        ? Effect.void
        : db.release({ attempt: job.attempt, sessionId }).pipe(Effect.asVoid)
    )
  );
  return result;
});
