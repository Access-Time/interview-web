import { integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const recordingSession = sqliteTable("recording_session", {
  createdAt: integer("created_at").notNull(),
  id: text("id").primaryKey(),
});

export const recordingSegment = sqliteTable(
  "recording_segment",
  {
    createdAt: integer("created_at").notNull(),
    id: text("id").primaryKey(),
    index: integer("segment_index").notNull(),
    recorderMimeType: text("recorder_mime_type"),
    requestedMimeType: text("requested_mime_type"),
    sessionId: text("session_id")
      .notNull()
      .references(() => recordingSession.id, { onDelete: "cascade" }),
  },
  (table) => [
    unique("recording_segment_session_index_unique").on(
      table.sessionId,
      table.index
    ),
  ]
);

export const recordingUploadPart = sqliteTable(
  "recording_upload_part",
  {
    byteSize: integer("byte_size").notNull(),
    checksum: text("checksum").notNull(),
    createdAt: integer("created_at").notNull(),
    etag: text("etag").notNull(),
    id: text("id").primaryKey(),
    mediaType: text("media_type"),
    objectKey: text("object_key").notNull(),
    segmentId: text("segment_id")
      .notNull()
      .references(() => recordingSegment.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
  },
  (table) => [
    unique("recording_upload_part_segment_sequence_unique").on(
      table.segmentId,
      table.sequence
    ),
    unique("recording_upload_part_object_key_unique").on(table.objectKey),
  ]
);
