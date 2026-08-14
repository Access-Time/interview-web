import { env } from "@interview-web/env/server";
import { and, asc, desc, eq, gt, isNull, lt, ne, or, sql } from "drizzle-orm";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import {
  recordingSegment,
  recordingSession,
  recordingUploadPart,
} from "./schema/recording-manifest";

export type Database = DrizzleD1Database<typeof schema>;

const schema = {
  recordingSegment,
  recordingSession,
  recordingUploadPart,
};

export function createDb(db: D1Database = env.DB): Database {
  return drizzle(db, { schema });
}

export class RecordingUploadPartConflictError extends Error {
  readonly segmentId: string;
  readonly sequence: number;

  constructor(segmentId: string, sequence: number, cause?: unknown) {
    super(
      `Upload part ${segmentId}/${sequence} conflicts with the existing manifest entry`,
      { cause }
    );
    this.name = "RecordingUploadPartConflictError";
    this.segmentId = segmentId;
    this.sequence = sequence;
  }
}

export class RecordingSegmentOwnershipError extends Error {
  readonly segmentId: string;
  readonly sessionId: string;

  constructor(segmentId: string, sessionId: string) {
    super(
      `Recording segment ${segmentId} does not belong to session ${sessionId}`
    );
    this.name = "RecordingSegmentOwnershipError";
    this.segmentId = segmentId;
    this.sessionId = sessionId;
  }
}

export class CreateRecordingSessionConflictError extends Error {
  readonly segmentId: string;
  readonly sessionId: string;

  constructor(segmentId: string, sessionId: string) {
    super(
      `Recording session ${sessionId} or segment ${segmentId} conflicts with the existing manifest`
    );
    this.name = "CreateRecordingSessionConflictError";
    this.segmentId = segmentId;
    this.sessionId = sessionId;
  }
}

export class AppendRecordingSegmentConflictError extends Error {
  readonly segmentId: string;
  readonly sessionId: string;

  constructor(
    segmentId: string,
    sessionId: string,
    message = "Recording segment append conflicts with the existing manifest"
  ) {
    super(message);
    this.name = "AppendRecordingSegmentConflictError";
    this.segmentId = segmentId;
    this.sessionId = sessionId;
  }
}

export interface CreateRecordingSessionInput {
  createdAt?: number;
  recorderMimeType?: string | null;
  requestedMimeType?: string | null;
  segmentId: string;
  sessionId: string;
}

export interface CreateRecordingSessionResult {
  recorderMimeType: string | null;
  requestedMimeType: string | null;
  segmentId: string;
  sessionId: string;
}

export interface AppendRecordingSegmentInput {
  createdAt?: number;
  recorderMimeType?: string | null;
  requestedMimeType?: string | null;
  segmentId: string;
  sessionId: string;
}

export interface AppendRecordingSegmentResult {
  index: number;
  recorderMimeType: string | null;
  requestedMimeType: string | null;
  segmentId: string;
  sessionId: string;
}

export interface RecordingStatus {
  error?: string;
  output?: {
    mediaType: string | null;
    byteSize: number | null;
    hasOutput: boolean;
  };
  status: "queued" | "finalizing" | "ready" | "failed";
}

export type RecordingPlaybackStatus =
  | "recording"
  | "queued"
  | "finalizing"
  | "ready"
  | "failed"
  | "deleting";

export interface RecordingPlaybackCursor {
  createdAt: number;
  id: string;
}

export interface RecordingPlaybackSummary {
  createdAt: number;
  hasOutput: boolean;
  id: string;
  outputByteSize: number | null;
  outputMediaType: string | null;
  status: RecordingPlaybackStatus;
}

export interface RecordingPlaybackPage {
  items: RecordingPlaybackSummary[];
  nextCursor: RecordingPlaybackCursor | null;
}
export interface RecordingFinalizeInput {
  segments: Array<{ segmentId: string; partCount: number }>;
  sessionId: string;
}
export interface RecordingFinalizeResult {
  status: "queued" | "finalizing" | "ready" | "failed";
}
export class RecordingFinalizeConflictError extends Error {
  constructor(
    message = "The recording finalization plan conflicts with the sealed plan"
  ) {
    super(message);
    this.name = "RecordingFinalizeConflictError";
  }
}
export class RecordingNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Recording session ${sessionId} was not found`);
    this.name = "RecordingNotFoundError";
  }
}

export function createRecordingSession(
  db: Database,
  {
    sessionId,
    segmentId,
    createdAt = Date.now(),
    requestedMimeType = null,
    recorderMimeType = null,
  }: CreateRecordingSessionInput
): Promise<CreateRecordingSessionResult> {
  return db
    .batch([
      db.insert(recordingSession).values({ createdAt, id: sessionId }),
      db.insert(recordingSegment).values({
        createdAt,
        id: segmentId,
        index: 0,
        recorderMimeType,
        requestedMimeType,
        sessionId,
      }),
    ])
    .then(() => ({
      recorderMimeType,
      requestedMimeType,
      segmentId,
      sessionId,
    }))
    .catch(async (error: unknown) => {
      const [session, segment, initialSegment] = await Promise.all([
        db
          .select({ id: recordingSession.id })
          .from(recordingSession)
          .where(eq(recordingSession.id, sessionId))
          .get(),
        db
          .select({
            id: recordingSegment.id,
            index: recordingSegment.index,
            recorderMimeType: recordingSegment.recorderMimeType,
            requestedMimeType: recordingSegment.requestedMimeType,
            sessionId: recordingSegment.sessionId,
          })
          .from(recordingSegment)
          .where(eq(recordingSegment.id, segmentId))
          .get(),
        db
          .select({ id: recordingSegment.id })
          .from(recordingSegment)
          .where(
            and(
              eq(recordingSegment.sessionId, sessionId),
              eq(recordingSegment.index, 0)
            )
          )
          .get(),
      ]);
      if (
        session &&
        segment?.id === segmentId &&
        segment.sessionId === sessionId &&
        segment.index === 0 &&
        initialSegment?.id === segmentId &&
        segment.requestedMimeType === requestedMimeType &&
        segment.recorderMimeType === recorderMimeType
      ) {
        return {
          recorderMimeType,
          requestedMimeType,
          segmentId,
          sessionId,
        };
      }
      if (session || segment || initialSegment) {
        throw new CreateRecordingSessionConflictError(segmentId, sessionId);
      }
      throw error;
    });
}

export async function appendRecordingSegment(
  db: Database,
  input: AppendRecordingSegmentInput
): Promise<AppendRecordingSegmentResult> {
  const createdAt = input.createdAt ?? Date.now();

  // The session status and contiguous predecessor check are part of the insert
  // statement, so sealing cannot race an append between read and write.
  try {
    await db.run(sql`
      INSERT INTO recording_segment
        (created_at, id, segment_index, recorder_mime_type, requested_mime_type, session_id)
      SELECT ${createdAt}, ${input.segmentId},
        (SELECT coalesce(max(segment_index) + 1, 0)
          FROM recording_segment WHERE session_id = ${input.sessionId}),
        ${input.recorderMimeType ?? null}, ${input.requestedMimeType ?? null}, ${input.sessionId}
      FROM recording_session
      WHERE id = ${input.sessionId}
        AND status = 'recording'
        AND (SELECT coalesce(max(segment_index) + 1, 0)
          FROM recording_segment WHERE session_id = ${input.sessionId}) < 5
    `);
  } catch {
    // A concurrent append may have won either unique constraint; inspect below
    // to distinguish an idempotent retry from an actual conflict.
  }

  const existing = await db
    .select({
      id: recordingSegment.id,
      index: recordingSegment.index,
      recorderMimeType: recordingSegment.recorderMimeType,
      requestedMimeType: recordingSegment.requestedMimeType,
      sessionId: recordingSegment.sessionId,
    })
    .from(recordingSegment)
    .where(eq(recordingSegment.id, input.segmentId))
    .get();
  const session = await db
    .select({ status: recordingSession.status })
    .from(recordingSession)
    .where(eq(recordingSession.id, input.sessionId))
    .get();
  if (
    session?.status === "recording" &&
    existing &&
    existing.sessionId === input.sessionId &&
    existing.recorderMimeType === (input.recorderMimeType ?? null) &&
    existing.requestedMimeType === (input.requestedMimeType ?? null)
  ) {
    return { ...existing, segmentId: existing.id };
  }
  throw new AppendRecordingSegmentConflictError(
    input.segmentId,
    input.sessionId
  );
}

export interface RecordingManifest {
  createdAt: number;
  segments: Array<{
    id: string;
    index: number;
    createdAt: number;
    recorderMimeType: string | null;
    requestedMimeType: string | null;
    parts: Array<{
      id: string;
      sequence: number;
      objectKey: string;
      byteSize: number;
      checksum: string;
      etag: string;
      createdAt: number;
      mediaType: string | null;
    }>;
  }>;
  sessionId: string;
}

export async function getRecordingManifest(
  db: Database,
  sessionId: string
): Promise<RecordingManifest | null> {
  const session = await db
    .select()
    .from(recordingSession)
    .where(eq(recordingSession.id, sessionId))
    .get();
  if (!session) {
    return null;
  }
  const segments = await db
    .select()
    .from(recordingSegment)
    .where(eq(recordingSegment.sessionId, sessionId))
    .orderBy(asc(recordingSegment.index));
  const parts = await db
    .select()
    .from(recordingUploadPart)
    .innerJoin(
      recordingSegment,
      eq(recordingUploadPart.segmentId, recordingSegment.id)
    )
    .where(eq(recordingSegment.sessionId, sessionId))
    .orderBy(asc(recordingSegment.index), asc(recordingUploadPart.sequence));

  return {
    createdAt: session.createdAt,
    segments: segments.map((segment) => ({
      createdAt: segment.createdAt,
      id: segment.id,
      index: segment.index,
      parts: parts
        .filter(
          ({ recording_upload_part: part }) => part.segmentId === segment.id
        )
        .map(({ recording_upload_part: part }) => part),
      recorderMimeType: segment.recorderMimeType,
      requestedMimeType: segment.requestedMimeType,
    })),
    sessionId,
  };
}

function planJson(segments: Array<{ segmentId: string; partCount: number }>) {
  return JSON.stringify(segments);
}
type PublicState = RecordingStatus["status"];
const INVALID_SESSION_ID = /[\\/]/;
const INVALID_OBJECT_NAME = /^[^/]+$/;
const SHA256_CHECKSUM = /^[a-fA-F0-9]{64}$/;

function publicState(status: string): PublicState | null {
  return status === "queued" ||
    status === "finalizing" ||
    status === "ready" ||
    status === "failed"
    ? status
    : null;
}

function validateFinalizationPlan(
  input: RecordingFinalizeInput,
  segments: Array<{ id: string; index: number }>,
  counts: Array<{ segmentId: string; sequence: number }>
): string {
  if (
    segments.length !== input.segments.length ||
    segments.some((segment, index) => segment.index !== index)
  ) {
    throw new RecordingFinalizeConflictError(
      "Finalization plan does not match the manifest"
    );
  }
  const partCounts = new Map(
    input.segments.map((segment) => [segment.segmentId, segment.partCount])
  );
  for (const segment of segments) {
    const partSequences = counts
      .filter((part) => part.segmentId === segment.id)
      .map((part) => part.sequence)
      .sort((a, b) => a - b);
    const partCount = partCounts.get(segment.id);
    if (
      partCount === undefined ||
      partSequences.length !== partCount ||
      partSequences.some((sequence, index) => sequence !== index)
    ) {
      throw new RecordingFinalizeConflictError(
        "Finalization plan does not match the manifest"
      );
    }
  }
  return planJson(
    segments.map((segment) => ({
      partCount: partCounts.get(segment.id) as number,
      segmentId: segment.id,
    }))
  );
}

async function tryFinalizeRecording(
  db: Database,
  input: RecordingFinalizeInput
): Promise<{ plan: string; result: RecordingFinalizeResult | null }> {
  const session = await db
    .select()
    .from(recordingSession)
    .where(eq(recordingSession.id, input.sessionId))
    .get();
  if (!session) {
    throw new RecordingNotFoundError(input.sessionId);
  }
  const segments = await db
    .select({ id: recordingSegment.id, index: recordingSegment.index })
    .from(recordingSegment)
    .where(eq(recordingSegment.sessionId, input.sessionId))
    .orderBy(asc(recordingSegment.index));
  const counts = await db
    .select({
      segmentId: recordingUploadPart.segmentId,
      sequence: recordingUploadPart.sequence,
    })
    .from(recordingUploadPart)
    .innerJoin(
      recordingSegment,
      eq(recordingUploadPart.segmentId, recordingSegment.id)
    )
    .where(eq(recordingSegment.sessionId, input.sessionId));
  const plan = validateFinalizationPlan(input, segments, counts);
  if (session.finalizePlan && session.finalizePlan !== plan) {
    throw new RecordingFinalizeConflictError();
  }
  if (session.status === "deleting") {
    throw new RecordingFinalizeConflictError("Recording is being deleted");
  }
  if (session.status === "failed") {
    const requeued = await db
      .update(recordingSession)
      .set({ status: "queued" })
      .where(
        and(
          eq(recordingSession.id, input.sessionId),
          eq(recordingSession.status, "failed"),
          eq(recordingSession.finalizePlan, plan),
          eq(recordingSession.manifestVersion, session.manifestVersion)
        )
      );
    return {
      plan,
      result: requeued.meta.changes ? { status: "queued" } : null,
    };
  }
  if (session.status !== "recording") {
    const state = publicState(session.status);
    if (!state || session.finalizePlan !== plan) {
      throw new RecordingFinalizeConflictError();
    }
    return { plan, result: { status: state } };
  }
  const changed = await db
    .update(recordingSession)
    .set({ finalizePlan: plan, status: "queued" })
    .where(
      and(
        eq(recordingSession.id, input.sessionId),
        eq(recordingSession.status, "recording"),
        eq(recordingSession.manifestVersion, session.manifestVersion)
      )
    );
  return { plan, result: changed.meta.changes ? { status: "queued" } : null };
}

export async function finalizeRecording(
  db: Database,
  input: RecordingFinalizeInput
): Promise<RecordingFinalizeResult> {
  if (
    !input.segments.length ||
    input.segments.some(
      (s) => !(s.segmentId && Number.isInteger(s.partCount)) || s.partCount <= 0
    ) ||
    new Set(input.segments.map((s) => s.segmentId)).size !==
      input.segments.length
  ) {
    throw new RecordingFinalizeConflictError("Invalid finalization plan");
  }
  let canonicalPlan = "";
  for (let retry = 0; retry < 3; retry += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: CAS retries must remain sequential.
    const attempt = await tryFinalizeRecording(db, input);
    canonicalPlan = attempt.plan;
    if (attempt.result) {
      return attempt.result;
    }
  }
  const current = await db
    .select()
    .from(recordingSession)
    .where(eq(recordingSession.id, input.sessionId))
    .get();
  if (!current) {
    throw new RecordingNotFoundError(input.sessionId);
  }
  if (current.status === "deleting" || current.finalizePlan !== canonicalPlan) {
    throw new RecordingFinalizeConflictError();
  }
  const state = publicState(current.status);
  if (!state) {
    throw new RecordingFinalizeConflictError("Recording is still recording");
  }
  return { status: state };
}
export async function getRecordingStatus(
  db: Database,
  sessionId: string
): Promise<RecordingStatus | null> {
  const session = await db
    .select()
    .from(recordingSession)
    .where(eq(recordingSession.id, sessionId))
    .get();
  if (
    !session ||
    session.status === "recording" ||
    session.status === "deleting"
  ) {
    return null;
  }
  const status = publicState(session.status);
  if (!status) {
    return null;
  }
  return {
    status,
    ...(status === "ready"
      ? {
          output: {
            byteSize: session.outputByteSize,
            hasOutput: !!session.outputObjectKey,
            mediaType: session.outputMediaType,
          },
        }
      : {}),
    ...(status === "failed"
      ? { error: session.failureCode ?? "finalization failed" }
      : {}),
  };
}

const PLAYBACK_PAGE_SIZE = 25;

interface PlaybackSummaryRow {
  createdAt: number;
  id: string;
  outputByteSize: number | null;
  outputMediaType: string | null;
  outputObjectKey: string | null;
  status: string;
}

const playbackSummaryColumns = {
  createdAt: recordingSession.createdAt,
  id: recordingSession.id,
  outputByteSize: recordingSession.outputByteSize,
  outputMediaType: recordingSession.outputMediaType,
  outputObjectKey: recordingSession.outputObjectKey,
  status: recordingSession.status,
};

function toRecordingPlaybackSummary(
  row: PlaybackSummaryRow
): RecordingPlaybackSummary {
  return {
    createdAt: row.createdAt,
    hasOutput: Boolean(row.outputObjectKey),
    id: row.id,
    outputByteSize: row.outputByteSize,
    outputMediaType: row.outputMediaType,
    status: row.status as RecordingPlaybackStatus,
  };
}

export async function getRecordingPlaybackSummary(
  db: Database,
  sessionId: string
): Promise<RecordingPlaybackSummary | null> {
  const row = await db
    .select(playbackSummaryColumns)
    .from(recordingSession)
    .where(eq(recordingSession.id, sessionId))
    .get();

  return row ? toRecordingPlaybackSummary(row) : null;
}

export async function listRecordingPlaybackSummaries(
  db: Database,
  input: { cursor?: RecordingPlaybackCursor }
): Promise<RecordingPlaybackPage> {
  const rows = input.cursor
    ? await db
        .select(playbackSummaryColumns)
        .from(recordingSession)
        .where(
          or(
            lt(recordingSession.createdAt, input.cursor.createdAt),
            and(
              eq(recordingSession.createdAt, input.cursor.createdAt),
              lt(recordingSession.id, input.cursor.id)
            )
          )
        )
        .orderBy(desc(recordingSession.createdAt), desc(recordingSession.id))
        .limit(PLAYBACK_PAGE_SIZE + 1)
    : await db
        .select(playbackSummaryColumns)
        .from(recordingSession)
        .orderBy(desc(recordingSession.createdAt), desc(recordingSession.id))
        .limit(PLAYBACK_PAGE_SIZE + 1);
  const items = rows
    .slice(0, PLAYBACK_PAGE_SIZE)
    .map(toRecordingPlaybackSummary);
  const lastItem = items.at(-1);

  return {
    items,
    nextCursor:
      rows.length > PLAYBACK_PAGE_SIZE && lastItem
        ? { createdAt: lastItem.createdAt, id: lastItem.id }
        : null,
  };
}

export async function claimRecordingFinalization(
  db: Database,
  sessionId: string,
  now = Date.now(),
  leaseMs = 300_000
) {
  const claimed = await db
    .update(recordingSession)
    .set({
      finalizationAttempt: sql`${recordingSession.finalizationAttempt} + 1`,
      leaseExpiresAt: now + leaseMs,
      status: "finalizing",
    })
    .where(
      and(
        eq(recordingSession.id, sessionId),
        or(
          eq(recordingSession.status, "queued"),
          and(
            eq(recordingSession.status, "finalizing"),
            or(
              isNull(recordingSession.leaseExpiresAt),
              lt(recordingSession.leaseExpiresAt, now)
            )
          )
        )
      )
    )
    .returning({
      attempt: recordingSession.finalizationAttempt,
      finalizePlan: recordingSession.finalizePlan,
      leaseExpiresAt: recordingSession.leaseExpiresAt,
    });
  const [token] = claimed;
  if (!token) {
    return null;
  }
  const manifest = await getRecordingManifest(db, sessionId);
  return manifest ? { ...token, attempt: token.attempt, manifest } : null;
}
export interface RecordingFinalizationOutput {
  byteSize: number;
  checksum: string;
  mediaType: string | null;
  objectKey: string;
}
function validOutput(input: {
  sessionId: string;
  attempt: number;
  output: RecordingFinalizationOutput;
}) {
  const prefix = `recordings/${encodeURIComponent(input.sessionId)}/finalizations/attempt-${input.attempt}/`;
  return (
    input.sessionId.length > 0 &&
    input.sessionId.length <= 256 &&
    !INVALID_SESSION_ID.test(input.sessionId) &&
    Number.isInteger(input.attempt) &&
    input.attempt > 0 &&
    input.attempt <= 2_147_483_647 &&
    input.output.objectKey.startsWith(prefix) &&
    INVALID_OBJECT_NAME.test(input.output.objectKey.slice(prefix.length)) &&
    input.output.byteSize > 0 &&
    (input.output.mediaType === "video/webm" ||
      input.output.mediaType === "video/mp4") &&
    SHA256_CHECKSUM.test(input.output.checksum)
  );
}
export async function completeRecordingFinalization(
  db: Database,
  input: {
    sessionId: string;
    attempt: number;
    output: RecordingFinalizationOutput;
    now?: number;
  }
) {
  const now = input.now ?? Date.now();
  if (!validOutput(input)) {
    return false;
  }
  const r = await db
    .update(recordingSession)
    .set({
      leaseExpiresAt: null,
      outputByteSize: input.output.byteSize,
      outputChecksum: input.output.checksum,
      outputMediaType: input.output.mediaType,
      outputObjectKey: input.output.objectKey,
      status: "ready",
    })
    .where(
      and(
        eq(recordingSession.id, input.sessionId),
        eq(recordingSession.status, "finalizing"),
        eq(recordingSession.finalizationAttempt, input.attempt),
        or(
          isNull(recordingSession.leaseExpiresAt),
          gt(recordingSession.leaseExpiresAt, now)
        )
      )
    );
  return !!r.meta.changes;
}
export async function failRecordingFinalization(
  db: Database,
  input: {
    sessionId: string;
    attempt: number;
    failureCode: string;
    now?: number;
  }
) {
  const now = input.now ?? Date.now();
  const r = await db
    .update(recordingSession)
    .set({
      failureCode: input.failureCode.slice(0, 128),
      leaseExpiresAt: null,
      status: "failed",
    })
    .where(
      and(
        eq(recordingSession.id, input.sessionId),
        eq(recordingSession.status, "finalizing"),
        eq(recordingSession.finalizationAttempt, input.attempt),
        or(
          isNull(recordingSession.leaseExpiresAt),
          gt(recordingSession.leaseExpiresAt, now)
        )
      )
    );
  return !!r.meta.changes;
}
export async function renewRecordingFinalizationLease(
  db: Database,
  input: { sessionId: string; attempt: number; now?: number; leaseMs?: number }
) {
  const now = input.now ?? Date.now();
  const r = await db
    .update(recordingSession)
    .set({ leaseExpiresAt: now + (input.leaseMs ?? 300_000) })
    .where(
      and(
        eq(recordingSession.id, input.sessionId),
        eq(recordingSession.status, "finalizing"),
        eq(recordingSession.finalizationAttempt, input.attempt),
        or(
          isNull(recordingSession.leaseExpiresAt),
          gt(recordingSession.leaseExpiresAt, now)
        )
      )
    );
  return !!r.meta.changes;
}
export async function releaseRecordingFinalizationForRetry(
  db: Database,
  input: { sessionId: string; attempt: number; now?: number }
): Promise<boolean> {
  const now = input.now ?? Date.now();
  const result = await db
    .update(recordingSession)
    .set({ leaseExpiresAt: null, status: "queued" })
    .where(
      and(
        eq(recordingSession.id, input.sessionId),
        eq(recordingSession.status, "finalizing"),
        eq(recordingSession.finalizationAttempt, input.attempt),
        or(
          isNull(recordingSession.leaseExpiresAt),
          gt(recordingSession.leaseExpiresAt, now)
        )
      )
    );
  return !!result.meta.changes;
}
export async function listRecordingsForFinalization(
  db: Database,
  now = Date.now(),
  limit = 20
): Promise<string[]> {
  const boundedLimit = Math.max(1, Math.min(20, Math.trunc(limit)));
  const rows = await db
    .select({ id: recordingSession.id })
    .from(recordingSession)
    .where(
      or(
        eq(recordingSession.status, "queued"),
        and(
          eq(recordingSession.status, "finalizing"),
          or(
            isNull(recordingSession.leaseExpiresAt),
            lt(recordingSession.leaseExpiresAt, now)
          )
        )
      )
    )
    .orderBy(asc(recordingSession.createdAt), asc(recordingSession.id))
    .limit(boundedLimit);
  return rows.map(({ id }) => id);
}
export async function beginRecordingDeletion(
  db: Database,
  sessionId: string,
  now = Date.now()
) {
  const row = await db
    .update(recordingSession)
    .set({ status: "deleting" })
    .where(
      and(
        eq(recordingSession.id, sessionId),
        ne(recordingSession.status, "deleting")
      )
    )
    .returning({ leaseExpiresAt: recordingSession.leaseExpiresAt });
  const lease =
    row[0]?.leaseExpiresAt ??
    (
      await db
        .select({ leaseExpiresAt: recordingSession.leaseExpiresAt })
        .from(recordingSession)
        .where(
          and(
            eq(recordingSession.id, sessionId),
            eq(recordingSession.status, "deleting")
          )
        )
        .get()
    )?.leaseExpiresAt;
  return row.length || lease !== undefined
    ? {
        activeLeaseExpiresAt: lease && lease > now ? lease : null,
        state: "deleting" as const,
      }
    : { activeLeaseExpiresAt: null, state: "missing" as const };
}
export async function completeRecordingDeletion(
  db: Database,
  sessionId: string,
  now = Date.now()
) {
  const r = await db
    .delete(recordingSession)
    .where(
      and(
        eq(recordingSession.id, sessionId),
        eq(recordingSession.status, "deleting"),
        or(
          isNull(recordingSession.leaseExpiresAt),
          lt(recordingSession.leaseExpiresAt, now)
        )
      )
    );
  return !!r.meta.changes;
}
export async function getReadyRecordingSubmission(
  db: Database,
  sessionId: string
) {
  const r = await db
    .select({
      byteSize: recordingSession.outputByteSize,
      checksum: recordingSession.outputChecksum,
      mediaType: recordingSession.outputMediaType,
      objectKey: recordingSession.outputObjectKey,
    })
    .from(recordingSession)
    .where(
      and(
        eq(recordingSession.id, sessionId),
        eq(recordingSession.status, "ready")
      )
    )
    .get();
  return r?.objectKey ? r : null;
}
export const retryRecordingFinalization = async (
  db: Database,
  sessionId: string
) =>
  !!(
    await db
      .update(recordingSession)
      .set({ status: "queued" })
      .where(
        and(
          eq(recordingSession.id, sessionId),
          eq(recordingSession.status, "failed")
        )
      )
      .run()
  ).meta.changes;

export interface AcknowledgeRecordingUploadPartInput {
  byteSize: number;
  checksum: string;
  createdAt?: number;
  etag: string;
  mediaType?: string | null;
  objectKey: string;
  partId: string;
  segmentId: string;
  sequence: number;
  sessionId: string;
}

export async function acknowledgeRecordingUploadPart(
  db: Database,
  input: AcknowledgeRecordingUploadPartInput
) {
  const segment = await db
    .select({ id: recordingSegment.id })
    .from(recordingSegment)
    .where(
      and(
        eq(recordingSegment.id, input.segmentId),
        eq(recordingSegment.sessionId, input.sessionId)
      )
    )
    .get();
  if (!segment) {
    throw new RecordingSegmentOwnershipError(input.segmentId, input.sessionId);
  }

  try {
    await db.batch([
      db
        .insert(recordingUploadPart)
        .values({
          byteSize: input.byteSize,
          checksum: input.checksum,
          createdAt: input.createdAt ?? Date.now(),
          etag: input.etag,
          id: input.partId,
          mediaType: input.mediaType ?? null,
          objectKey: input.objectKey,
          segmentId: input.segmentId,
          sequence: input.sequence,
        })
        .onConflictDoNothing({
          target: [recordingUploadPart.segmentId, recordingUploadPart.sequence],
        }),
    ]);
  } catch (error: unknown) {
    if (String(error).includes("recording is not accepting parts")) {
      // biome-ignore lint/style/useErrorCause: the conflict error preserves the database error as a cause.
      throw new RecordingUploadPartConflictError(
        input.segmentId,
        input.sequence,
        error
      );
    }
    throw error;
  }

  const existing = await db
    .select()
    .from(recordingUploadPart)
    .where(
      and(
        eq(recordingUploadPart.segmentId, input.segmentId),
        eq(recordingUploadPart.sequence, input.sequence)
      )
    )
    .get();
  if (!existing) {
    throw new Error("Recording upload part was not persisted");
  }
  if (
    existing.objectKey !== input.objectKey ||
    existing.byteSize !== input.byteSize ||
    existing.checksum !== input.checksum ||
    existing.mediaType !== (input.mediaType ?? null)
  ) {
    throw new RecordingUploadPartConflictError(input.segmentId, input.sequence);
  }
  const session = await db
    .select({ status: recordingSession.status })
    .from(recordingSession)
    .innerJoin(
      recordingSegment,
      eq(recordingSegment.sessionId, recordingSession.id)
    )
    .where(eq(recordingSegment.id, input.segmentId))
    .get();
  if (existing.etag !== input.etag && session?.status !== "recording") {
    throw new RecordingUploadPartConflictError(input.segmentId, input.sequence);
  }
  if (existing.etag !== input.etag) {
    await db
      .update(recordingUploadPart)
      .set({ etag: input.etag })
      .where(eq(recordingUploadPart.id, existing.id));
    return { ...existing, etag: input.etag };
  }
  return existing;
}
