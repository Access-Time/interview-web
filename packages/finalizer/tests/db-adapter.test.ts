import { expect, it } from "@effect/vitest";
import { vi } from "vitest";

vi.mock("@interview-web/db", () => ({
  claimRecordingFinalization: vi.fn(),
  completeRecordingFinalization: vi.fn(),
  failRecordingFinalization: vi.fn(),
  getReadyRecordingSubmission: vi.fn(),
  listRecordingsForFinalization: vi.fn(),
  releaseRecordingFinalizationForRetry: vi.fn(),
  renewRecordingFinalizationLease: vi.fn(),
}));

import { claimRecordingFinalization } from "@interview-web/db";
import { Effect } from "effect";
import { FinalizerDb, makeFinalizerDb } from "../src/worker/db.ts";

it.effect(
  "makeFinalizerDb maps claim rejection to FinalizerDbUnavailable",
  () => {
    vi.mocked(claimRecordingFinalization).mockRejectedValueOnce(
      new Error("d1 down")
    );
    return FinalizerDb.pipe(
      Effect.flatMap((db) => db.claim("session" as never)),
      Effect.provide(makeFinalizerDb({} as never)),
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error._tag).toBe("FinalizerDbUnavailable");
        })
      )
    );
  }
);
