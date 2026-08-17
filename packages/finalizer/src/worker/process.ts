import { Effect, Exit, Option, Schedule } from "effect";
import type { SessionId } from "../domain/brands.ts";
import {
  isTerminalFinalization,
  LeaseLost,
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
const exact = (
  meta: Parameters<typeof isExactPublishedObject>[0],
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
    const mediaType = outputMediaType(manifest as never);
    const outputKey = `recordings/${encodeURIComponent(sessionId)}/finalizations/attempt-${attempt}/output.${mediaType === "video/mp4" ? "mp4" : "webm"}`;
    const controller = new AbortController();
    yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()));
    // Container deletion is best-effort; publication must not be undone by cleanup.
    yield* Effect.addFinalizer(() =>
      container.deleteJob(job).pipe(Effect.ignore)
    );
    const heartbeat = db
      .renew({ attempt, sessionId })
      .pipe(Effect.repeat(Schedule.fixed("60 seconds")), Effect.asVoid);
    const work = Effect.gen(function* () {
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
            signal: controller.signal,
          });
        }
      }
      yield* container
        .finalize({
          job,
          outputMediaType: mediaType,
          segments: manifest.segments.map((segment) => ({
            partIndexes: segment.parts.map((part) => part.sequence),
            segmentIndex: segment.index,
          })),
          signal: controller.signal,
        })
        .pipe(Effect.retry(retrySchedule));
      const output = yield* container
        .getOutput(job, controller.signal)
        .pipe(Effect.retry(retrySchedule));
      const expected = {
        checksum: output.checksum,
        mediaType: output.mediaType,
        size: output.size,
      };
      const publishAndComplete = Effect.gen(function* () {
        const published = yield* Effect.gen(function* () {
          const written = yield* recordings.put(outputKey, output.body, {
            httpMetadata: { contentType: output.mediaType },
            onlyIf: { etagDoesNotMatch: "*" },
            sha256: output.checksum,
          });
          if (Option.isNone(written)) {
            const head = yield* recordings.head(outputKey);
            if (!exact(Option.getOrUndefined(head), expected)) {
              return yield* Effect.fail(
                new OutputPublicationNotProven({
                  message: "output publication not proven",
                })
              );
            }
            return false;
          }
          if (!exact(written.value, expected)) {
            return yield* Effect.fail(
              new OutputPublicationMetadataMismatch({
                message: "output publication metadata mismatch",
              })
            );
          }
          return true;
        }).pipe(Effect.retry(retrySchedule));
        const completed = yield* db.complete({
          attempt,
          output: {
            byteSize: expected.size,
            checksum: expected.checksum as never,
            mediaType: expected.mediaType,
            objectKey: outputKey,
          },
          sessionId,
        });
        if (!completed) {
          return yield* Effect.fail(
            new LeaseLost({ message: "finalization lease lost" })
          );
        }
        return { outputKey, published };
      });
      return yield* Effect.exit(publishAndComplete).pipe(
        Effect.flatMap((exit) =>
          Effect.gen(function* () {
            const ready = yield* db.ready(sessionId);
            const exactReady =
              Option.isSome(ready) &&
              ready.value.objectKey === outputKey &&
              ready.value.mediaType === expected.mediaType &&
              ready.value.byteSize === expected.size &&
              ready.value.checksum.toLowerCase() ===
                expected.checksum.toLowerCase();
            if (!exactReady) {
              yield* recordings.delete(outputKey);
            }
            return yield* Exit.matchEffect(exit, {
              onFailure: (cause) => Effect.failCause(cause),
              onSuccess: (value) => Effect.succeed(value),
            });
          })
        )
      );
    });
    return yield* Effect.raceFirst(work, heartbeat);
  });

export const processFinalization = Effect.fn("processFinalization")(function* (
  sessionId: SessionId
) {
  const db = yield* FinalizerDb;
  const claimed = yield* db.claim(sessionId);
  if (Option.isNone(claimed)) {
    return;
  }
  const job = claimed.value;
  return yield* Effect.gen(function* () {
    const manifest = yield* decodeManifest(job.manifest);
    yield* decodeFinalizePlan(manifest, job.finalizePlan);
    return yield* runAttempt(sessionId, job.attempt, manifest as never).pipe(
      Effect.scoped
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
});
