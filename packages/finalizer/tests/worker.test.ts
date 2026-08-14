import { expect, it } from "vitest";
import {
  isExactFinalizerOutput,
  outputMediaType,
  validateFinalizePlan,
  validateManifest,
} from "../src/pure.ts";

it("manifest validation accepts contiguous bounded parts", () => {
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
  expect(validateManifest(manifest)).toBe(1);
  expect(outputMediaType(manifest)).toBe("video/webm");
  expect(
    validateFinalizePlan(
      manifest,
      JSON.stringify([{ partCount: 1, segmentId: "seg" }])
    )
  ).toEqual([{ partCount: 1, segmentId: "seg" }]);
});

it("manifest validation rejects gaps", () => {
  expect(() =>
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
  ).toThrow();
  expect(() =>
    validateFinalizePlan(
      { segments: [{ id: "seg", index: 0, parts: [] }], sessionId: "s" },
      "[]"
    )
  ).toThrow();
});

it("media type defaults safely and exact output matching is strict", () => {
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
  expect(outputMediaType(base)).toBe("video/webm");
  expect(
    outputMediaType({
      ...base,
      segments: [
        {
          ...segment,
          parts: [{ ...part, mediaType: "video/webm" }],
          recorderMimeType: "video/mp4",
        },
      ],
    })
  ).toBe("video/webm");
  expect(
    outputMediaType({
      ...base,
      segments: [
        {
          ...segment,
          parts: [{ ...part, mediaType: "video/mp4" }],
          recorderMimeType: "video/mp4",
        },
      ],
    })
  ).toBe("video/mp4");
  const output = {
    byteSize: 1,
    checksum: "a".repeat(64),
    mediaType: "video/webm",
    objectKey: "k",
  };
  expect(isExactFinalizerOutput(output, { ...output })).toBe(true);
  expect(isExactFinalizerOutput(output, { ...output, byteSize: 2 })).toBe(
    false
  );
});
