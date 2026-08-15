import z from "zod";

export const recordingIdDto = z.string().min(1).max(128);

export const sessionInputDto = z.object({
  recorderMimeType: z.string().nullable().optional(),
  requestedMimeType: z.string().nullable().optional(),
  segmentId: recordingIdDto,
  sessionId: recordingIdDto,
});

export const sessionIdInputDto = z.object({
  sessionId: recordingIdDto,
});

export const playbackCursorDto = z.object({
  createdAt: z.number().int().nonnegative(),
  id: recordingIdDto,
});

export const listPlaybackSummariesInputDto = z.object({
  cursor: playbackCursorDto.optional(),
});

export const finalizeInputDto = z.object({
  segments: z
    .array(
      z.object({
        partCount: z.number().int().positive(),
        segmentId: recordingIdDto,
      })
    )
    .min(1)
    .max(5)
    .superRefine((segments, context) => {
      if (
        new Set(segments.map(({ segmentId }) => segmentId)).size !==
        segments.length
      ) {
        context.addIssue({
          code: "custom",
          message: "segment IDs must be unique",
        });
      }
    }),
  sessionId: recordingIdDto,
});

export type SessionInputDto = z.infer<typeof sessionInputDto>;
export type SessionIdInputDto = z.infer<typeof sessionIdInputDto>;
export type FinalizeInputDto = z.infer<typeof finalizeInputDto>;
export type ListPlaybackSummariesInputDto = z.infer<
  typeof listPlaybackSummariesInputDto
>;
