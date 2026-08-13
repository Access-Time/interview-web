import {
  beginRecordingDeletion,
  completeRecordingDeletion,
  createDb,
  getReadyRecordingSubmission,
} from "@interview-web/db";
import { env } from "@interview-web/env/server";
import { createFileRoute } from "@tanstack/react-router";
import {
  handleRecordingSubmission,
  type RecordingSubmissionBindings,
} from "../../../../server/recording-submission";

const bindings = (): RecordingSubmissionBindings => ({
  beginDeletion: (sessionId) => beginRecordingDeletion(createDb(), sessionId),
  completeDeletion: (sessionId) =>
    completeRecordingDeletion(createDb(), sessionId),
  getReadySubmission: async (sessionId) => {
    const submission = await getReadyRecordingSubmission(createDb(), sessionId);
    return submission?.objectKey
      ? { contentType: submission.mediaType, objectKey: submission.objectKey }
      : null;
  },
  storage: {
    delete: (key) => env.RECORDINGS.delete(key),
    get: async (key, range) => {
      const object = await env.RECORDINGS.get(
        key,
        range ? { range } : undefined
      );
      return object
        ? {
            body: object.body,
            contentType: object.httpMetadata?.contentType,
            httpEtag: object.httpEtag,
            size: object.size,
          }
        : null;
    },
    head: async (key) => {
      const object = await env.RECORDINGS.head(key);
      return object
        ? {
            contentType: object.httpMetadata?.contentType,
            httpEtag: object.httpEtag,
            size: object.size,
          }
        : null;
    },
    list: async (prefix, cursor) => {
      const page = await env.RECORDINGS.list({ cursor, prefix });
      return {
        objects: page.objects.map(({ key }) => ({ key })),
        truncated: page.truncated,
        ...(page.truncated && page.cursor ? { cursor: page.cursor } : {}),
      };
    },
  },
});

const handle = ({
  request,
  params,
}: {
  request: Request;
  params: { sessionId: string };
}) => handleRecordingSubmission(request, params, bindings());

export const Route = createFileRoute("/api/recordings/$sessionId/submission")({
  server: {
    handlers: {
      DELETE: handle,
      GET: handle,
      HEAD: handle,
    },
  },
});
