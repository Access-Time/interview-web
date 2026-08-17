import { Schema } from "effect";

export class InvalidManifest extends Schema.TaggedError<InvalidManifest>()(
  "InvalidManifest",
  { message: Schema.String }
) {}
export class IncompleteManifest extends Schema.TaggedError<IncompleteManifest>()(
  "IncompleteManifest",
  { message: Schema.String }
) {}
export class InvalidPart extends Schema.TaggedError<InvalidPart>()(
  "InvalidPart",
  { message: Schema.String }
) {}
export class InputTooLarge extends Schema.TaggedError<InputTooLarge>()(
  "InputTooLarge",
  { message: Schema.String }
) {}
export class InvalidFinalizePlan extends Schema.TaggedError<InvalidFinalizePlan>()(
  "InvalidFinalizePlan",
  { message: Schema.String }
) {}
export class MissingOrCorruptPart extends Schema.TaggedError<MissingOrCorruptPart>()(
  "MissingOrCorruptPart",
  { message: Schema.String }
) {}
export class InvalidContainerOutput extends Schema.TaggedError<InvalidContainerOutput>()(
  "InvalidContainerOutput",
  { message: Schema.String }
) {}
export class ContainerRejected extends Schema.TaggedError<ContainerRejected>()(
  "ContainerRejected",
  { message: Schema.String, status: Schema.Number }
) {}
export class FfmpegFailed extends Schema.TaggedError<FfmpegFailed>()(
  "FfmpegFailed",
  { message: Schema.String, stderr: Schema.optional(Schema.String) }
) {}
export class NoMediaStream extends Schema.TaggedError<NoMediaStream>()(
  "NoMediaStream",
  { message: Schema.String }
) {}
export class JobNotOpen extends Schema.TaggedError<JobNotOpen>()("JobNotOpen", {
  message: Schema.String,
}) {}
export class PartsPlanMismatch extends Schema.TaggedError<PartsPlanMismatch>()(
  "PartsPlanMismatch",
  { message: Schema.String }
) {}
export class PartAlreadyDiffers extends Schema.TaggedError<PartAlreadyDiffers>()(
  "PartAlreadyDiffers",
  { message: Schema.String }
) {}

export class LeaseLost extends Schema.TaggedError<LeaseLost>()("LeaseLost", {
  message: Schema.String,
}) {}
export class OutputSizeMismatch extends Schema.TaggedError<OutputSizeMismatch>()(
  "OutputSizeMismatch",
  { message: Schema.String }
) {}
export class OutputChecksumMismatch extends Schema.TaggedError<OutputChecksumMismatch>()(
  "OutputChecksumMismatch",
  { message: Schema.String }
) {}
export class OutputPublicationNotProven extends Schema.TaggedError<OutputPublicationNotProven>()(
  "OutputPublicationNotProven",
  { cause: Schema.optional(Schema.String), message: Schema.String }
) {}
export class OutputPublicationMetadataMismatch extends Schema.TaggedError<OutputPublicationMetadataMismatch>()(
  "OutputPublicationMetadataMismatch",
  { message: Schema.String }
) {}
export class ContainerUnavailable extends Schema.TaggedError<ContainerUnavailable>()(
  "ContainerUnavailable",
  { message: Schema.String, status: Schema.optional(Schema.Number) }
) {}
export class QueueSendFailed extends Schema.TaggedError<QueueSendFailed>()(
  "QueueSendFailed",
  { message: Schema.String }
) {}
export class RecordingsUnavailable extends Schema.TaggedError<RecordingsUnavailable>()(
  "RecordingsUnavailable",
  { message: Schema.String }
) {}
export class FinalizerDbUnavailable extends Schema.TaggedError<FinalizerDbUnavailable>()(
  "FinalizerDbUnavailable",
  { message: Schema.String }
) {}

const terminalTags = new Set([
  "InvalidManifest",
  "IncompleteManifest",
  "InvalidPart",
  "InputTooLarge",
  "InvalidFinalizePlan",
  "MissingOrCorruptPart",
  "InvalidContainerOutput",
  "ContainerRejected",
  "FfmpegFailed",
  "NoMediaStream",
  "JobNotOpen",
  "PartsPlanMismatch",
  "PartAlreadyDiffers",
]);

export function isTerminalFinalization(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    typeof error._tag === "string" &&
    terminalTags.has(error._tag)
  );
}
