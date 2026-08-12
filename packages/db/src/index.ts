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

export interface CreateRecordingSessionInput {
  createdAt?: number;
  segmentId: string;
  sessionId: string;
}

export function createRecordingSession(
  db: Database,
  { sessionId, segmentId, createdAt = Date.now() }: CreateRecordingSessionInput
) {
  return db.transaction(async (tx) => {
    await tx.insert(recordingSession).values({ createdAt, id: sessionId });
    await tx.insert(recordingSegment).values({
      createdAt,
      id: segmentId,
      index: 0,
      sessionId,
    });
    return { segmentId, sessionId };
  });
}

export interface RecordingManifest {
  createdAt: number;
  segments: Array<{
    id: string;
    index: number;
    createdAt: number;
    parts: Array<{
      id: string;
      sequence: number;
      objectKey: string;
      byteSize: number;
      checksum: string;
      etag: string;
      createdAt: number;
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
    })),
    sessionId,
  };
}

export interface AcknowledgeRecordingUploadPartInput {
  byteSize: number;
  checksum: string;
  createdAt?: number;
  etag: string;
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
  return db.transaction(async (tx) => {
    const segment = await tx
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
      throw new Error("Recording segment does not belong to the session");
    }

    const existing = await tx
      .select()
      .from(recordingUploadPart)
      .where(
        and(
          eq(recordingUploadPart.segmentId, input.segmentId),
          eq(recordingUploadPart.sequence, input.sequence)
        )
      )
      .get();
    if (existing) {
      if (
        existing.objectKey !== input.objectKey ||
        existing.byteSize !== input.byteSize ||
        existing.checksum !== input.checksum ||
        existing.etag !== input.etag
      ) {
        throw new RecordingUploadPartConflictError(
          input.segmentId,
          input.sequence
        );
      }
      return existing;
    }

    return tx
      .insert(recordingUploadPart)
      .values({
        byteSize: input.byteSize,
        checksum: input.checksum,
        createdAt: input.createdAt ?? Date.now(),
        etag: input.etag,
        id: input.partId,
        objectKey: input.objectKey,
        segmentId: input.segmentId,
        sequence: input.sequence,
      })
      .returning()
      .get();
  });
}
