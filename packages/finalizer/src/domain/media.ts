export const MAX_SEGMENTS = 5;
export const MAX_INPUT_BYTES = 2 * 1024 * 1024 * 1024;

export interface FinalizerPart {
  byteSize: number;
  checksum: string;
  mediaType?: string | null;
  objectKey: string;
  sequence: number;
}
export interface FinalizerManifest {
  segments: Array<{
    id: string;
    index: number;
    parts: FinalizerPart[];
    recorderMimeType?: string | null;
    requestedMimeType?: string | null;
  }>;
  sessionId: string;
}

export function outputMediaType(m: FinalizerManifest) {
  const types = m.segments
    .flatMap((s) => [
      s.recorderMimeType,
      s.requestedMimeType,
      ...s.parts.map((p) => p.mediaType),
    ])
    .filter((type): type is string => Boolean(type));
  return types.length > 0 &&
    types.every((type) => type.split(";")[0] === "video/mp4")
    ? "video/mp4"
    : "video/webm";
}

export interface FinalizerOutput {
  byteSize: number | null;
  checksum: string | null;
  mediaType: string | null;
  objectKey: string | null;
}
export function isExactFinalizerOutput(
  candidate: FinalizerOutput,
  ready: FinalizerOutput | null | undefined
) {
  return (
    !!ready &&
    ready.objectKey === candidate.objectKey &&
    ready.mediaType === candidate.mediaType &&
    ready.byteSize === candidate.byteSize &&
    ready.checksum?.toLowerCase() === candidate.checksum?.toLowerCase()
  );
}

export type Sha256Checksum = string | ArrayBuffer | ArrayBufferView;

export function normalizeSha256Checksum(
  checksum: Sha256Checksum | undefined
): string | undefined {
  if (checksum === undefined) {
    return undefined;
  }
  if (typeof checksum === "string") {
    return checksum.toLowerCase();
  }
  const bytes =
    checksum instanceof ArrayBuffer
      ? new Uint8Array(checksum)
      : new Uint8Array(
          checksum.buffer,
          checksum.byteOffset,
          checksum.byteLength
        );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
}

export function isExactPublishedObject(
  meta:
    | {
        checksums?: { sha256?: Sha256Checksum };
        httpMetadata?: { contentType?: string };
        size: number;
      }
    | null
    | undefined,
  expected: { checksum: string; mediaType: string; size: number }
) {
  return (
    !!meta &&
    meta.size === expected.size &&
    normalizeSha256Checksum(meta.checksums?.sha256) === expected.checksum &&
    meta.httpMetadata?.contentType === expected.mediaType
  );
}

export async function deterministicJobName(sessionId: string, attempt: number) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${sessionId}:${attempt}`)
  );
  return [...new Uint8Array(digest.slice(0, 18))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
