import { skipToken, useMutation, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { orpc } from "@/utils/orpc";
import { isRecordingNotFoundError } from "@/utils/recording-errors";
import {
  normalizeFinalizationStatus,
  type RecordingManifestLookup,
} from "./live-recording";

const STATUS_POLL_MS = 1000;

export function useRecordingApi(keys: {
  manifestSessionId: string | null;
  statusSessionId: string | null;
}) {
  const createSession = useMutation(orpc.recording.create.mutationOptions());
  const appendSegment = useMutation(
    orpc.recording.appendSegment.mutationOptions()
  );
  const finalizeSession = useMutation(
    orpc.recording.finalize.mutationOptions()
  );

  const manifestQuery = useQuery({
    ...orpc.recording.getManifest.queryOptions({
      input: keys.manifestSessionId
        ? { sessionId: keys.manifestSessionId }
        : skipToken,
    }),
    retry: false,
  });

  const statusQuery = useQuery({
    ...orpc.recording.getStatus.queryOptions({
      input: keys.statusSessionId
        ? { sessionId: keys.statusSessionId }
        : skipToken,
    }),
    refetchInterval: (query) => {
      if (!keys.statusSessionId) {
        return false;
      }
      const status = normalizeFinalizationStatus(query.state.data);
      if (status === "ready" || status === "failed") {
        return false;
      }
      return STATUS_POLL_MS;
    },
    staleTime: 0,
  });

  const manifestLookup = useMemo((): RecordingManifestLookup | undefined => {
    if (!keys.manifestSessionId || manifestQuery.isPending) {
      return undefined;
    }
    if (isRecordingNotFoundError(manifestQuery.error)) {
      return { kind: "missing" };
    }
    if (manifestQuery.data) {
      return { kind: "found", manifest: manifestQuery.data };
    }
    return undefined;
  }, [
    keys.manifestSessionId,
    manifestQuery.data,
    manifestQuery.error,
    manifestQuery.isPending,
  ]);

  return {
    appendSegment: appendSegment.mutate,
    createSession: createSession.mutate,
    finalizeSession: finalizeSession.mutate,
    manifestLookup,
    status: normalizeFinalizationStatus(statusQuery.data),
  };
}
