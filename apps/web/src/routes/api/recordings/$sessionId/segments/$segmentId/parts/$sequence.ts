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
            delete: (key) => env.RECORDINGS.delete(key),
            head: async (key) => {
              const object = await env.RECORDINGS.head(key);
              return object
                ? {
                    checksums: { sha256: object.checksums?.sha256 },
                    etag: object.etag,
                    size: object.size,
                  }
                : null;
            },
            put: (key, body, options) =>
              env.RECORDINGS.put(key, body, {
                onlyIf: options.onlyIf,
                sha256: options.sha256,
              }),
          },
        } satisfies RecordingUploadBindings),
    },
  },
});
