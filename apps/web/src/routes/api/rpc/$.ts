import { createContext } from "@interview-web/api/context";
import { appRouter } from "@interview-web/api/routers/index";
import {
  appendRecordingSegment,
  createDb,
  createRecordingSession,
  finalizeRecording,
  getRecordingManifest,
  getRecordingStatus,
} from "@interview-web/db";
import { env } from "@interview-web/env/server";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { createFileRoute } from "@tanstack/react-router";

const rpcHandler = new RPCHandler(appRouter, {
  interceptors: [
    onError((error) => {
      console.error(error);
    }),
  ],
});

const apiHandler = new OpenAPIHandler(appRouter, {
  interceptors: [
    onError((error) => {
      console.error(error);
    }),
  ],
  plugins: [
    new OpenAPIReferencePlugin({
      schemaConverters: [new ZodToJsonSchemaConverter()],
    }),
  ],
});

export interface FinalizerDispatcher {
  fetch: (request: Request) => Promise<Response>;
}

export async function dispatchFinalization(
  finalizer: FinalizerDispatcher,
  sessionId: string
): Promise<void> {
  const response = await finalizer.fetch(
    new Request("https://finalizer/internal/finalizations", {
      body: JSON.stringify({ sessionId }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
  );
  if (!response.ok) {
    throw new Error("Finalization dispatch failed");
  }
}

async function handle({ request }: { request: Request }) {
  const context = await createContext({
    bindings: {
      appendRecordingSegment: (input) =>
        appendRecordingSegment(createDb(), input),
      createRecordingSession: (input) =>
        createRecordingSession(createDb(), input),
      enqueueFinalization: (sessionId) =>
        dispatchFinalization(env.FINALIZER, sessionId),
      finalizeRecording: (input) => finalizeRecording(createDb(), input),
      getRecordingManifest: (sessionId) =>
        getRecordingManifest(createDb(), sessionId),
      getRecordingStatus: (sessionId) =>
        getRecordingStatus(createDb(), sessionId),
    },
  });
  const rpcResult = await rpcHandler.handle(request, {
    context,
    prefix: "/api/rpc",
  });
  if (rpcResult.response) {
    return rpcResult.response;
  }

  const apiResult = await apiHandler.handle(request, {
    context,
    prefix: "/api/rpc/api-reference",
  });
  if (apiResult.response) {
    return apiResult.response;
  }

  return new Response("Not found", { status: 404 });
}

export const Route = createFileRoute("/api/rpc/$")({
  server: {
    handlers: {
      DELETE: handle,
      GET: handle,
      HEAD: handle,
      PATCH: handle,
      POST: handle,
      PUT: handle,
    },
  },
});
