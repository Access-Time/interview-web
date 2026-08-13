import assert from "node:assert/strict";
import test from "node:test";
import {
  isExactFinalizerOutput,
  outputMediaType,
  validateFinalizePlan,
  validateManifest,
} from "../src/pure.ts";

test("manifest validation accepts contiguous bounded parts", () => {
  const manifest = {
    segments: [
      {
        id: "seg",
        index: 0,
        parts: [
          {
            byteSize: 1,
            checksum: "a".repeat(64),
            mediaType: "video/webm",
            objectKey: "p",
            sequence: 0,
          },
        ],
      },
    ],
    sessionId: "s",
  };
  assert.equal(validateManifest(manifest), 1);
  assert.equal(outputMediaType(manifest), "video/webm");
  assert.deepEqual(
    validateFinalizePlan(
      manifest,
      JSON.stringify([{ partCount: 1, segmentId: "seg" }])
    ),
    [{ partCount: 1, segmentId: "seg" }]
  );
});

test("manifest validation rejects gaps", () => {
  assert.throws(() =>
    validateManifest({
      segments: [
        {
          id: "seg",
          index: 0,
          parts: [
            {
              byteSize: 1,
              checksum: "a".repeat(64),
              objectKey: "p",
              sequence: 1,
            },
          ],
        },
      ],
      sessionId: "s",
    })
  );
  assert.throws(() =>
    validateFinalizePlan(
      { segments: [{ id: "seg", index: 0, parts: [] }], sessionId: "s" },
      "[]"
    )
  );
});

test("media type defaults safely and exact output matching is strict", () => {
  const base = {
    segments: [
      {
        id: "seg",
        index: 0,
        parts: [
          {
            byteSize: 1,
            checksum: "a".repeat(64),
            objectKey: "p",
            sequence: 0,
          },
        ],
      },
    ],
    sessionId: "s",
  };
  const [segment] = base.segments;
  const [part] = segment.parts;
  assert.equal(outputMediaType(base), "video/webm");
  assert.equal(
    outputMediaType({
      ...base,
      segments: [
        {
          ...segment,
          parts: [{ ...part, mediaType: "video/webm" }],
          recorderMimeType: "video/mp4",
        },
      ],
    }),
    "video/webm"
  );
  assert.equal(
    outputMediaType({
      ...base,
      segments: [
        {
          ...segment,
          parts: [{ ...part, mediaType: "video/mp4" }],
          recorderMimeType: "video/mp4",
        },
      ],
    }),
    "video/mp4"
  );
  const output = {
    byteSize: 1,
    checksum: "a".repeat(64),
    mediaType: "video/webm",
    objectKey: "k",
  };
  assert.equal(isExactFinalizerOutput(output, { ...output }), true);
  assert.equal(
    isExactFinalizerOutput(output, { ...output, byteSize: 2 }),
    false
  );
});
