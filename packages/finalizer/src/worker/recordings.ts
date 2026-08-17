import { Context, Effect, Layer, Option } from "effect";
import type { Sha256Hex } from "../domain/brands.ts";
import {
  MissingOrCorruptPart,
  type OutputPublicationNotProven,
  RecordingsUnavailable,
} from "../domain/errors.ts";
import { normalizeSha256Checksum } from "../domain/media.ts";

export interface PartObject {
  body: Uint8Array;
  checksum: Sha256Hex;
  size: number;
}
export interface PublishedMeta {
  checksums?: { sha256?: string | ArrayBuffer | ArrayBufferView };
  httpMetadata?: { contentType?: string };
  size: number;
}

interface PutBodyOptions {
  httpMetadata: { contentType: string };
  onlyIf: { etagDoesNotMatch: "*" };
  sha256: string;
  size: number;
}

export class Recordings extends Context.Tag("Recordings")<
  Recordings,
  {
    readonly get: (
      key: string
    ) => Effect.Effect<
      PartObject,
      MissingOrCorruptPart | RecordingsUnavailable
    >;
    readonly put: (
      key: string,
      body: ReadableStream<Uint8Array> | Uint8Array,
      options: PutBodyOptions
    ) => Effect.Effect<
      Option.Option<PublishedMeta>,
      OutputPublicationNotProven | RecordingsUnavailable
    >;
    readonly head: (
      key: string
    ) => Effect.Effect<Option.Option<PublishedMeta>, RecordingsUnavailable>;
    readonly delete: (
      key: string
    ) => Effect.Effect<void, RecordingsUnavailable>;
  }
>() {
  static get = (key: string) =>
    Effect.flatMap(Recordings, (service) => service.get(key));
  static head = (key: string) =>
    Effect.flatMap(Recordings, (service) => service.head(key));
}

type Bucket = R2Bucket;
const digest = async (bytes: Uint8Array) => {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return normalizeSha256Checksum(hash) as string;
};
const unavailable = (error: unknown) =>
  new RecordingsUnavailable({ message: String(error) });

const putKnownLength = async (
  bucket: Bucket,
  key: string,
  body: ReadableStream<Uint8Array> | Uint8Array,
  options: PutBodyOptions
) => {
  const putOptions = {
    httpMetadata: options.httpMetadata,
    onlyIf: options.onlyIf,
    sha256: options.sha256,
  };
  if (body instanceof Uint8Array) {
    return bucket.put(key, body, putOptions);
  }
  const { readable, writable } = new FixedLengthStream(options.size);
  const [object] = await Promise.all([
    bucket.put(key, readable, putOptions),
    body.pipeTo(writable),
  ]);
  return object;
};

export const makeRecordings = (bucket: Bucket): Layer.Layer<Recordings> =>
  Layer.succeed(Recordings, {
    delete: (key) =>
      Effect.tryPromise({
        catch: unavailable,
        try: () => bucket.delete(key),
      }),
    get: (key) =>
      Effect.gen(function* () {
        const object = yield* Effect.tryPromise({
          catch: unavailable,
          try: () => bucket.get(key),
        });
        if (!object?.body) {
          return yield* Effect.fail(
            new MissingOrCorruptPart({
              message: "missing or corrupt part",
            })
          );
        }
        const body = yield* Effect.tryPromise({
          catch: unavailable,
          try: async () => new Uint8Array(await object.arrayBuffer()),
        });
        const checksum = normalizeSha256Checksum(object.checksums?.sha256);
        if (
          body.byteLength !== object.size ||
          !checksum ||
          checksum !==
            (yield* Effect.tryPromise({
              catch: unavailable,
              try: () => digest(body),
            }))
        ) {
          return yield* Effect.fail(
            new MissingOrCorruptPart({
              message: "missing or corrupt part",
            })
          );
        }
        return {
          body,
          checksum: checksum as Sha256Hex,
          size: body.byteLength,
        };
      }),
    head: (key) =>
      Effect.tryPromise({
        catch: unavailable,
        try: async () => Option.fromNullable(await bucket.head(key)),
      }),
    put: (key, body, options) =>
      Effect.tryPromise({
        catch: unavailable,
        try: async () =>
          Option.fromNullable(await putKnownLength(bucket, key, body, options)),
      }),
  });

type Store =
  | Map<string, PartObject | PublishedMeta>
  | Record<string, PartObject | PublishedMeta>;
const read = (store: Store, key: string) =>
  store instanceof Map ? store.get(key) : store[key];
const write = (
  store: Store,
  key: string,
  value: PartObject | PublishedMeta
) => {
  if (store instanceof Map) {
    store.set(key, value);
  } else {
    store[key] = value;
  }
};
export const makeRecordingsTest = (store: Store): Layer.Layer<Recordings> =>
  Layer.succeed(Recordings, {
    delete: (key) =>
      Effect.sync(() => {
        if (store instanceof Map) {
          store.delete(key);
        } else {
          delete store[key];
        }
      }),
    get: (key) =>
      Effect.tryPromise({
        catch: (error) =>
          error instanceof MissingOrCorruptPart
            ? error
            : new MissingOrCorruptPart({ message: "missing or corrupt part" }),
        try: async () => {
          const entry = read(store, key);
          if (
            !(entry && "body" in entry) ||
            entry.size !== entry.body.byteLength ||
            (await digest(entry.body)) !== entry.checksum
          ) {
            throw new MissingOrCorruptPart({
              message: "missing or corrupt part",
            });
          }
          return entry;
        },
      }),
    head: (key) =>
      Effect.sync(() => {
        const entry = read(store, key);
        return Option.fromNullable(
          entry && !("body" in entry) ? entry : undefined
        );
      }),
    put: (key, body, options) =>
      Effect.sync(() => {
        const meta = {
          checksums: { sha256: options.sha256 },
          httpMetadata: options.httpMetadata,
          size: body instanceof Uint8Array ? body.byteLength : options.size,
        };
        write(store, key, meta);
        return Option.some(meta);
      }),
  });
