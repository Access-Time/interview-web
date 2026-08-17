import {
  claimRecordingFinalization,
  completeRecordingFinalization,
  type Database,
  failRecordingFinalization,
  getReadyRecordingSubmission,
  listRecordingsForFinalization,
  releaseRecordingFinalizationForRetry,
  renewRecordingFinalizationLease,
} from "@interview-web/db";
import { Context, Effect, Layer, Option } from "effect";
import type { SessionId } from "../domain/brands.ts";
import { FinalizerDbUnavailable, LeaseLost } from "../domain/errors.ts";
import type { FinalizerManifest, PublishedObject } from "../domain/schema.ts";

export interface ClaimedJob {
  attempt: number;
  finalizePlan: string;
  manifest: FinalizerManifest;
}

export class FinalizerDb extends Context.Tag("FinalizerDb")<
  FinalizerDb,
  {
    readonly claim: (
      sessionId: SessionId
    ) => Effect.Effect<Option.Option<ClaimedJob>, FinalizerDbUnavailable>;
    readonly complete: (input: {
      sessionId: SessionId;
      attempt: number;
      output: PublishedObject;
    }) => Effect.Effect<boolean, FinalizerDbUnavailable>;
    readonly fail: (input: {
      sessionId: SessionId;
      attempt: number;
      failureCode: string;
    }) => Effect.Effect<boolean, FinalizerDbUnavailable>;
    readonly release: (input: {
      sessionId: SessionId;
      attempt: number;
    }) => Effect.Effect<boolean, FinalizerDbUnavailable>;
    readonly renew: (input: {
      sessionId: SessionId;
      attempt: number;
    }) => Effect.Effect<boolean, LeaseLost | FinalizerDbUnavailable>;
    readonly ready: (
      sessionId: SessionId
    ) => Effect.Effect<Option.Option<PublishedObject>, FinalizerDbUnavailable>;
    readonly listDue: (
      now: number,
      limit: number
    ) => Effect.Effect<readonly SessionId[], FinalizerDbUnavailable>;
  }
>() {}

const unavailable = (error: unknown) =>
  new FinalizerDbUnavailable({ message: String(error) });

const promise = <A>(thunk: () => Promise<A>) =>
  Effect.tryPromise({ catch: unavailable, try: thunk });

export const makeFinalizerDb = (db: Database): Layer.Layer<FinalizerDb> =>
  Layer.succeed(FinalizerDb, {
    claim: (sessionId) =>
      promise(() => claimRecordingFinalization(db, sessionId)).pipe(
        Effect.map((job) =>
          job ? Option.some(job as unknown as ClaimedJob) : Option.none()
        )
      ),
    complete: (input) =>
      promise(() => completeRecordingFinalization(db, input)),
    fail: (input) => promise(() => failRecordingFinalization(db, input)),
    listDue: (now, limit) =>
      promise(() => listRecordingsForFinalization(db, now, limit)).pipe(
        Effect.map((ids) => ids as unknown as readonly SessionId[])
      ),
    ready: (sessionId) =>
      promise(() => getReadyRecordingSubmission(db, sessionId)).pipe(
        Effect.map((output) =>
          output ? Option.some(output as PublishedObject) : Option.none()
        )
      ),
    release: (input) =>
      promise(() => releaseRecordingFinalizationForRetry(db, input)),
    renew: (input) =>
      promise(() => renewRecordingFinalizationLease(db, input)).pipe(
        Effect.flatMap((ok) =>
          ok
            ? Effect.succeed(true)
            : Effect.fail(new LeaseLost({ message: "finalization lease lost" }))
        )
      ),
  });

export const makeFinalizerDbTest = (
  service: Partial<Context.Tag.Service<FinalizerDb>> = {}
) => Layer.succeed(FinalizerDb, service as Context.Tag.Service<FinalizerDb>);
