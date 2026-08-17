/** biome-ignore-all lint/suspicious/noBitwiseOperators: EBML fixture encoding is bitwise. */
import { expect, it } from "vitest";
import { makeWebmSeekable } from "../src/domain/webm-seekable.ts";

const encodeVint = (value: number) => {
  let width = 1;
  while (width < 8 && value >= 2 ** (7 * width) - 1) {
    width += 1;
  }
  const bytes = new Uint8Array(width);
  let remaining = value;
  for (let index = width - 1; index >= 0; index -= 1) {
    bytes[index] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  bytes[0] = (bytes[0] ?? 0) | (1 << (8 - width));
  return bytes;
};

const concatBytes = (parts: readonly Uint8Array[]) => {
  const size = parts.reduce((total, part) => total + part.byteLength, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
};

const encodeId = (id: number, width: number) => {
  const bytes = new Uint8Array(width);
  let remaining = id;
  for (let index = width - 1; index >= 0; index -= 1) {
    bytes[index] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  return bytes;
};

const element = (id: number, idWidth: number, payload: Uint8Array) =>
  concatBytes([encodeId(id, idWidth), encodeVint(payload.byteLength), payload]);

const unknownSize = new Uint8Array([
  0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
]);

const encodeUint = (value: number) => {
  if (value === 0) {
    return new Uint8Array([0]);
  }
  const bytes: number[] = [];
  let remaining = value;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }
  return new Uint8Array(bytes);
};

const writeFloat64 = (value: number) => {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setFloat64(0, value, false);
  return new Uint8Array(buffer);
};

const cluster = (timecode: number) =>
  element(0x1f_43_b6_75, 4, element(0xe7, 1, encodeUint(timecode)));

const buildWebm = () => {
  const info = element(0x15_49_a9_66, 4, element(0x44_89, 2, writeFloat64(0)));
  const payload = concatBytes([info, cluster(0), cluster(1000)]);
  const ebml = element(
    0x1a_45_df_a3,
    4,
    new Uint8Array([0x42, 0x86, 0x81, 0x01])
  );
  return concatBytes([ebml, encodeId(0x18_53_80_67, 4), unknownSize, payload]);
};

it("leaves non-webm bytes unchanged", () => {
  const input = new Uint8Array([1, 2, 3]);
  expect(makeWebmSeekable(input)).toBe(input);
});

it("appends Cues and patches Duration for MediaRecorder-style WebM", () => {
  const input = buildWebm();
  const output = makeWebmSeekable(input);
  expect(output.byteLength).toBeGreaterThan(input.byteLength);
  const cues = [0x1c, 0x53, 0xbb, 0x6b];
  const found = output.findIndex(
    (_byte, index) =>
      index + 4 <= output.byteLength &&
      cues.every((byte, cueIndex) => output[index + cueIndex] === byte)
  );
  expect(found).toBeGreaterThan(-1);
  expect(makeWebmSeekable(output).byteLength).toBe(output.byteLength);
});
