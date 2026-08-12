import { env } from "@interview-web/env/server";
import { and, asc, eq } from "drizzle-orm";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import {
  recordingSegment,
  recordingSession,
  recordingUploadPart,
} from "./schema/recording-manifest";
import { todo } from "./schema/todo";

export type Database = DrizzleD1Database<typeof schema>;

const schema = {
  recordingSegment,
  recordingSession,
  recordingUploadPart,
  todo,
};

export function createDb() {
  return drizzle(env.DB, { schema });
}

export class RecordingUploadPartConflictError extends Error {
  readonly segmentId: string;
  readonly sequence: number;

  constructor(segmentId: string, sequence: number) {
    super(
      `Upload part ${segmentId}/${sequence} conflicts with the existing manifest entry`
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

export function acknowledgeRecordingUploadPart(
  db: Database,
  input: AcknowledgeRecordingUploadPartInput
) {
  return db
    .select({ id: recordingSegment.id })
    .from(recordingSegment)
    .where(
      and(
        eq(recordingSegment.id, input.segmentId),
        eq(recordingSegment.sessionId, input.sessionId)
      )
    )
    .get()
    .then(async (segment) => {
      if (!segment) {
        throw new RecordingSegmentOwnershipError(
          input.segmentId,
          input.sessionId
        );
      }

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
            target: [
              recordingUploadPart.segmentId,
              recordingUploadPart.sequence,
            ],
          }),
      ]);

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
        throw new RecordingUploadPartConflictError(
          input.segmentId,
          input.sequence
        );
      }
      if (existing.etag !== input.etag) {
        await db
          .update(recordingUploadPart)
          .set({ etag: input.etag })
          .where(eq(recordingUploadPart.id, existing.id));
        return { ...existing, etag: input.etag };
      }
      return existing;
    });
}
