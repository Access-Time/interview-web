const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

export interface RecordingUploadStorage {
  head: (key: string) => Promise<{
    checksums: { sha256?: string };
    etag: string;
    size: number;
  } | null>;
  put: (
    key: string,
    body: ReadableStream<Uint8Array>,
    options: {
      onlyIf: { etagDoesNotMatch: "*" };
      sha256: string;
    }
  ) => Promise<{ etag: string; size: number } | null>;
}

export interface RecordingUploadAcknowledgement {
  byteSize: number;
  checksum: string;
  etag: string;
  id: string;
  mediaType?: string | null;
  objectKey: string;
}

export interface RecordingUploadBindings {
  acknowledge: (input: {
    byteSize: number;
    checksum: string;
    etag: string;
    mediaType: string | null;
    objectKey: string;
    partId: string;
    segmentId: string;
    sequence: number;
    sessionId: string;
  }) => Promise<RecordingUploadAcknowledgement>;
  storage: RecordingUploadStorage;
}

async function storeRecordingUploadPart(
  objectKey: string,
  body: ReadableStream<Uint8Array>,
  checksum: string,
  storage: RecordingUploadStorage
): Promise<
  { newlyStored: boolean; stored: { etag: string; size: number } } | Response
> {
  try {
    const stored = await storage.put(objectKey, body, {
      onlyIf: { etagDoesNotMatch: "*" },
      sha256: checksum,
    });
    if (stored) {
      return { newlyStored: true, stored };
    }

    const existing = await storage.head(objectKey);
    if (!existing || existing.checksums.sha256?.toLowerCase() !== checksum) {
      return new Response(null, { status: 409 });
    }
    return { newlyStored: false, stored: existing };
  } catch {
    return new Response(null, { status: 500 });
  }
}

export async function handleRecordingUploadPart(
  request: Request,
  params: { sessionId: string; segmentId: string; sequence: string },
  bindings: RecordingUploadBindings
): Promise<Response> {
  if (request.method !== "PUT") {
    return new Response(null, { status: 405 });
  }
  if (!request.body) {
    return new Response(null, { status: 400 });
  }
  const checksum = request.headers.get("X-Content-SHA256");
  if (!(checksum && SHA256_PATTERN.test(checksum))) {
    return new Response(null, { status: 400 });
  }
  const normalizedChecksum = checksum.toLowerCase();
  const mediaType = request.headers.get("Content-Type");

  const sequence = Number(params.sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    return new Response(null, { status: 400 });
  }

  const objectKey = `recordings/${encodeURIComponent(params.sessionId)}/segments/${encodeURIComponent(params.segmentId)}/parts/${sequence}/sha256/${normalizedChecksum}`;
  const storageResult = await storeRecordingUploadPart(
    objectKey,
    request.body,
    normalizedChecksum,
    bindings.storage
  );
  if (storageResult instanceof Response) {
    return storageResult;
  }
  const { stored } = storageResult;

  const partId = crypto.randomUUID();
  try {
    const acknowledged = await bindings.acknowledge({
      byteSize: stored.size,
      checksum: normalizedChecksum,
      etag: stored.etag,
      mediaType,
      objectKey,
      partId,
      segmentId: params.segmentId,
      sequence,
      sessionId: params.sessionId,
    });
    const status = acknowledged.id === partId ? 201 : 200;
    return Response.json(
      {
        mediaType:
          acknowledged.mediaType === null ? mediaType : acknowledged.mediaType,
        objectKey: acknowledged.objectKey,
        partId: acknowledged.id,
        segmentId: params.segmentId,
        sequence,
        sessionId: params.sessionId,
      },
      { status }
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "RecordingSegmentOwnershipError"
    ) {
      return new Response(null, { status: 404 });
    }
    if (
      error instanceof Error &&
      error.name === "RecordingUploadPartConflictError"
    ) {
      return new Response(null, { status: 409 });
    }
    return new Response(null, { status: 500 });
  }
}
