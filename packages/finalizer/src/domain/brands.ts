import { Schema } from "effect";

export const SessionId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(128),
  Schema.brand("@interview-web/SessionId")
);
export type SessionId = typeof SessionId.Type;

export const Sha256Hex = Schema.String.pipe(
  Schema.lowercased(),
  Schema.pattern(/^[a-f0-9]{64}$/),
  Schema.brand("@interview-web/Sha256Hex")
);
export type Sha256Hex = typeof Sha256Hex.Type;
