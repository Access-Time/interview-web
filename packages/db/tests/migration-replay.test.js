import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createClient } from "@libsql/client";

const migrationDir = new URL("../src/migrations/", import.meta.url);
const statementBreakpointPattern = /--> statement-breakpoint/;
const invalidRecordingStatusPattern = /invalid recording status/;
const migrationFiles = [
  "0000_lethal_wendell_vaughn.sql",
  "0001_sticky_lionheart.sql",
  "0002_adorable_butterfly.sql",
  "0003_durable_finalization.sql",
];

async function applyMigrations(client, files = migrationFiles) {
  for (const file of files) {
    // biome-ignore lint/performance/noAwaitInLoops: migration files must replay in order.
    const sql = await fs.readFile(new URL(file, migrationDir), "utf8");
    for (const statement of sql.split(statementBreakpointPattern)) {
      if (statement.trim()) {
        // biome-ignore lint/performance/noAwaitInLoops: migration statements must execute in order.
        await client.execute(statement);
      }
    }
  }
}

test("0003 preserves a live recording manifest during replay", async (t) => {
  const databasePath = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "db-migration-")),
    "test.db"
  );
  const client = createClient({ url: `file:${databasePath}` });
  t.after(async () => {
    client.close();
    await fs.rm(path.dirname(databasePath), { force: true, recursive: true });
  });

  await applyMigrations(client, migrationFiles.slice(0, 3));
  await client.batch([
    {
      args: [1, "session"],
      sql: "INSERT INTO recording_session (created_at, id) VALUES (?, ?)",
    },
    {
      args: [1, "segment", 0, "session"],
      sql: "INSERT INTO recording_segment (created_at, id, segment_index, session_id) VALUES (?, ?, ?, ?)",
    },
    {
      args: [
        1,
        "checksum",
        1,
        "etag",
        "part",
        "video/webm",
        "object",
        "segment",
        0,
      ],
      sql: "INSERT INTO recording_upload_part (byte_size, checksum, created_at, etag, id, media_type, object_key, segment_id, sequence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    },
  ]);
  await applyMigrations(client, migrationFiles.slice(3));

  await client.execute(
    "INSERT INTO recording_segment (created_at, id, segment_index, session_id) VALUES (?, ?, ?, ?)",
    [1, "segment-2", 1, "session"]
  );
  await client.execute(
    "INSERT INTO recording_upload_part (byte_size, checksum, created_at, etag, id, media_type, object_key, segment_id, sequence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      1,
      "checksum-2",
      1,
      "etag-2",
      "part-2",
      "video/webm",
      "object-2",
      "segment-2",
      0,
    ]
  );

  const session = await client.execute(
    "SELECT status, finalization_attempt, manifest_version, finalize_plan, failure_code FROM recording_session WHERE id = 'session'"
  );
  assert.deepEqual(session.rows[0], {
    failure_code: null,
    finalization_attempt: 0,
    finalize_plan: null,
    manifest_version: 2,
    status: "recording",
  });
  assert.equal(
    (await client.execute("SELECT count(*) AS count FROM recording_segment"))
      .rows[0].count,
    2
  );
  assert.equal(
    (
      await client.execute(
        "SELECT count(*) AS count FROM recording_upload_part"
      )
    ).rows[0].count,
    2
  );

  const triggers = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name"
  );
  assert.deepEqual(
    triggers.rows.map(({ name }) => name),
    [
      "recording_segment_manifest_version",
      "recording_session_failure_code_guard",
      "recording_session_status_guard",
      "recording_session_status_insert_guard",
      "recording_upload_part_manifest_version",
      "recording_upload_part_recording_guard",
    ]
  );
  await assert.rejects(
    client.execute(
      "UPDATE recording_session SET status = 'bogus' WHERE id = 'session'"
    ),
    invalidRecordingStatusPattern
  );
});
