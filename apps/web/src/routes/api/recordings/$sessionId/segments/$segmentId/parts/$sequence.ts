import { acknowledgeRecordingUploadPart, createDb } from "@interview-web/db";
import { env } from "@interview-web/env/server";
import { createFileRoute } from "@tanstack/react-router";
import {
  handleRecordingUploadPart,
  type RecordingUploadBindings,
} from "../../../../../../../server/recording-upload";

export const Route = createFileRoute(
  "/api/recordings/$sessionId/segments/$segmentId/parts/$sequence"
)({
  server: {
    handlers: {
      PUT: ({ request, params }) =>
        handleRecordingUploadPart(request, params, {
          acknowledge: (input) =>
            acknowledgeRecordingUploadPart(createDb(), input),
          storage: {
            head: async (key) => {
              const object = await env.RECORDINGS.head(key);
              const sha256 = object?.checksums?.sha256;
              return object
                ? {
                    checksums: {
                      sha256:
                        sha256 instanceof ArrayBuffer
                          ? Array.from(new Uint8Array(sha256), (byte) =>
                              byte.toString(16).padStart(2, "0")
                            ).join("")
                          : undefined,
                    },
                    etag: object.etag,
                    size: object.size,
                  }
                : null;
            },
            put: (key, body, options) =>
              env.RECORDINGS.put(key, body, {
                onlyIf: options.onlyIf,
                sha256: Uint8Array.from(
                  options.sha256.match(/../g) ?? [],
                  (byte) => Number.parseInt(byte, 16)
                ),
              }),
          },
        } satisfies RecordingUploadBindings),
    },
  },
});
