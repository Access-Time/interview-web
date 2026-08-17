/** biome-ignore-all lint/suspicious/noBitwiseOperators: EBML vint and element IDs are bitwise. */
const EBML = 0x1a_45_df_a3;
const SEGMENT = 0x18_53_80_67;
const INFO = 0x15_49_a9_66;
const DURATION = 0x44_89;
const CLUSTER = 0x1f_43_b6_75;
const TIMECODE = 0xe7;
const CUES = 0x1c_53_bb_6b;
const CUE_POINT = 0xbb;
const CUE_TIME = 0xb3;
const CUE_TRACK_POSITIONS = 0xb7;
const CUE_TRACK = 0xf7;
const CUE_CLUSTER_POSITION = 0xf1;

const readByte = (data: Uint8Array, offset: number) =>
  offset >= 0 && offset < data.byteLength ? data[offset] : undefined;

const readVint = (data: Uint8Array, offset: number) => {
  const first = readByte(data, offset);
  if (first === undefined || first === 0) {
    return null;
  }
  let width = 1;
  let mask = 0x80;
  while (width <= 8 && (first & mask) === 0) {
    width += 1;
    mask >>= 1;
  }
  if (width > 8 || offset + width > data.byteLength) {
    return null;
  }
  let value = BigInt(first & (mask - 1));
  for (let index = 1; index < width; index += 1) {
    const byte = readByte(data, offset + index);
    if (byte === undefined) {
      return null;
    }
    value = (value << 8n) | BigInt(byte);
  }
  const unknown = value === (1n << BigInt(width * 7)) - 1n;
  return { unknown, value: unknown ? null : Number(value), width };
};

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

const encodeUint = (value: number) => {
  if (value <= 0) {
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

const idWidth = (id: number) => {
  if (id <= 0xff) {
    return 1;
  }
  if (id <= 0xff_ff) {
    return 2;
  }
  if (id <= 0xff_ff_ff) {
    return 3;
  }
  return 4;
};

const encodeId = (id: number) => {
  const width = idWidth(id);
  const bytes = new Uint8Array(width);
  let remaining = id;
  for (let index = width - 1; index >= 0; index -= 1) {
    bytes[index] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
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

const encodeElement = (id: number, payload: Uint8Array) =>
  concatBytes([encodeId(id), encodeVint(payload.byteLength), payload]);

const readId = (data: Uint8Array, offset: number) => {
  const first = readByte(data, offset);
  if (first === undefined || first === 0) {
    return null;
  }
  let width = 1;
  let mask = 0x80;
  while (width <= 4 && (first & mask) === 0) {
    width += 1;
    mask >>= 1;
  }
  if (width > 4 || offset + width > data.byteLength) {
    return null;
  }
  let id = 0;
  for (let index = 0; index < width; index += 1) {
    const byte = readByte(data, offset + index);
    if (byte === undefined) {
      return null;
    }
    id = (id << 8) | byte;
  }
  return { id, width };
};

const readElement = (data: Uint8Array, offset: number, limit: number) => {
  const id = readId(data, offset);
  if (!id || offset + id.width >= limit) {
    return null;
  }
  const size = readVint(data, offset + id.width);
  if (!size) {
    return null;
  }
  const dataOffset = offset + id.width + size.width;
  const end =
    size.value === null ? limit : Math.min(limit, dataOffset + size.value);
  if (end < dataOffset) {
    return null;
  }
  return {
    dataOffset,
    end,
    id: id.id,
    size: size.value,
    start: offset,
  };
};

const readUint = (data: Uint8Array, start: number, end: number) => {
  let value = 0;
  for (let offset = start; offset < end; offset += 1) {
    const byte = readByte(data, offset);
    if (byte === undefined) {
      return null;
    }
    value = value * 256 + byte;
  }
  return value;
};

const writeFloat64 = (value: number) => {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setFloat64(0, value, false);
  return new Uint8Array(buffer);
};

const looksLikeWebm = (data: Uint8Array) => {
  const header = readElement(data, 0, data.byteLength);
  return header?.id === EBML;
};

const findChild = (
  data: Uint8Array,
  start: number,
  end: number,
  id: number
) => {
  let offset = start;
  while (offset < end) {
    const child = readElement(data, offset, end);
    if (!child) {
      return null;
    }
    if (child.id === id) {
      return child;
    }
    offset = child.end;
  }
  return null;
};

const collectClusters = (data: Uint8Array, start: number, end: number) => {
  const clusters: Array<{ position: number; timecode: number }> = [];
  let offset = start;
  let hasCues = false;
  let duration: { end: number; start: number } | null = null;
  while (offset < end) {
    const element = readElement(data, offset, end);
    if (!element) {
      break;
    }
    if (element.id === CUES) {
      hasCues = true;
    }
    if (element.id === INFO) {
      const durationElement = findChild(
        data,
        element.dataOffset,
        element.end,
        DURATION
      );
      if (
        durationElement &&
        durationElement.end - durationElement.dataOffset === 8
      ) {
        duration = {
          end: durationElement.end,
          start: durationElement.dataOffset,
        };
      }
    }
    if (element.id === CLUSTER) {
      const timecodeElement = findChild(
        data,
        element.dataOffset,
        element.end,
        TIMECODE
      );
      clusters.push({
        position: element.start - start,
        timecode: timecodeElement
          ? (readUint(data, timecodeElement.dataOffset, timecodeElement.end) ??
            0)
          : 0,
      });
    }
    offset = element.end;
  }
  return { clusters, duration, hasCues };
};

const buildCues = (
  clusters: ReadonlyArray<{ position: number; timecode: number }>
) =>
  encodeElement(
    CUES,
    concatBytes(
      clusters.map((cluster) =>
        encodeElement(
          CUE_POINT,
          concatBytes([
            encodeElement(CUE_TIME, encodeUint(cluster.timecode)),
            encodeElement(
              CUE_TRACK_POSITIONS,
              concatBytes([
                encodeElement(CUE_TRACK, encodeUint(1)),
                encodeElement(
                  CUE_CLUSTER_POSITION,
                  encodeUint(cluster.position)
                ),
              ])
            ),
          ])
        )
      )
    )
  );

const patchDuration = (
  data: Uint8Array,
  duration: { start: number; end: number },
  value: number
) => {
  const next = new Uint8Array(data);
  next.set(writeFloat64(value), duration.start);
  return next;
};

/**
 * MediaRecorder WebM has no Cues and usually no Duration, so browsers treat
 * it as a live stream and disable timeline seeking. Append a Cues index and
 * patch Duration when the Info element already reserved 8 bytes for it.
 */
export const makeWebmSeekable = (input: Uint8Array): Uint8Array => {
  if (!looksLikeWebm(input)) {
    return input;
  }
  try {
    let offset = 0;
    while (offset < input.byteLength) {
      const element = readElement(input, offset, input.byteLength);
      if (!element) {
        return input;
      }
      if (element.id === SEGMENT) {
        const collected = collectClusters(
          input,
          element.dataOffset,
          element.end
        );
        if (collected.clusters.length === 0) {
          return input;
        }
        const last = collected.clusters.at(-1);
        const durationValue = last ? last.timecode + 1 : 0;
        const withDuration =
          collected.duration && last
            ? patchDuration(input, collected.duration, durationValue)
            : input;
        if (collected.hasCues) {
          return withDuration;
        }
        return concatBytes([withDuration, buildCues(collected.clusters)]);
      }
      offset = element.end;
    }
    return input;
  } catch {
    return input;
  }
};
