export const MAX_SEGMENTS = 5;
export const MAX_INPUT_BYTES = 2 * 1024 * 1024 * 1024;
const CHECKSUM = /^[a-f\d]{64}$/i;

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

export class TerminalFinalizationError extends Error {
  terminal = true;
}

export function validateManifest(m: FinalizerManifest) {
  if (
    !Array.isArray(m.segments) ||
    m.segments.length === 0 ||
    m.segments.length > MAX_SEGMENTS
  ) {
    throw new TerminalFinalizationError("invalid manifest");
  }
  let total = 0;
  m.segments.forEach((s, si) => {
    if (s.index !== si || !Array.isArray(s.parts) || !s.parts.length) {
      throw new TerminalFinalizationError("incomplete manifest");
    }
    s.parts.forEach((p, pi) => {
      if (
        p.sequence !== pi ||
        !Number.isSafeInteger(p.byteSize) ||
        p.byteSize <= 0 ||
        !CHECKSUM.test(p.checksum) ||
        !p.objectKey
      ) {
        throw new TerminalFinalizationError("invalid part");
      }
      total += p.byteSize;
    });
  });
  if (total > MAX_INPUT_BYTES) {
    throw new TerminalFinalizationError("input too large");
  }
  return total;
}

export function validateFinalizePlan(
  manifest: FinalizerManifest,
  planJson: unknown
) {
  let plan: unknown;
  try {
    plan = JSON.parse(String(planJson));
  } catch (error) {
    throw new TerminalFinalizationError("invalid finalization plan", {
      cause: error,
    });
  }
  if (!Array.isArray(plan) || plan.length !== manifest.segments.length) {
    throw new TerminalFinalizationError("finalization plan mismatch");
  }
  for (const [i, entry] of plan.entries()) {
    const segment = manifest.segments[i];
    if (
      !(segment && entry) ||
      typeof entry !== "object" ||
      (entry as { segmentId?: unknown }).segmentId !== segment.id ||
      (entry as { partCount?: unknown }).partCount !== segment.parts.length ||
      Object.keys(entry).length !== 2
    ) {
      throw new TerminalFinalizationError("finalization plan mismatch");
    }
  }
  return plan as Array<{ segmentId: string; partCount: number }>;
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

export async function deterministicJobName(sessionId: string, attempt: number) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${sessionId}:${attempt}`)
  );
  return [...new Uint8Array(digest.slice(0, 18))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
