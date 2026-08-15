import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { orpc } from "@/utils/orpc";
import { isRecordingNotFoundError } from "@/utils/recording-errors";
import { normalizeFinalizationStatus } from "./live-recording";
import type { RecordingCommands } from "./recording-commands";

export function useRecordingApi(): RecordingCommands {
  const queryClient = useQueryClient();
  const createSession = useMutation(orpc.recording.create.mutationOptions());
  const appendSegment = useMutation(
    orpc.recording.appendSegment.mutationOptions()
  );
  const finalizeSession = useMutation(
    orpc.recording.finalize.mutationOptions()
  );

  const getManifest = useCallback(
    async ({ sessionId }: { sessionId: string }) => {
      try {
        const manifest = await queryClient.fetchQuery({
          ...orpc.recording.getManifest.queryOptions({ input: { sessionId } }),
          retry: false,
          staleTime: 0,
        });
        return { kind: "found", manifest } as const;
      } catch (error) {
        if (isRecordingNotFoundError(error)) {
          return { kind: "missing" } as const;
        }
        throw error;
      }
    },
    [queryClient]
  );
  const getStatus = useCallback(
    async ({ sessionId }: { sessionId: string }) => {
      const result = await queryClient.fetchQuery({
        ...orpc.recording.getStatus.queryOptions({ input: { sessionId } }),
        staleTime: 0,
      });
      return normalizeFinalizationStatus(result);
    },
    [queryClient]
  );

  return {
    appendSegment: appendSegment.mutateAsync,
    createSession: createSession.mutateAsync,
    finalizeSession: finalizeSession.mutateAsync,
    getManifest,
    getStatus,
  };
}
