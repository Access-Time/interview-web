import type z from "zod";

export type ErrorSchema = Record<
  string,
  {
    data?: z.ZodType;
    message: string;
    status: number;
  }
>;

export type Prettify<T> = {
  [K in keyof T]: T[K];
} & {};

type ServiceErrorData<TEntry extends ErrorSchema[string]> =
  NonNullable<TEntry["data"]> extends z.ZodType
    ? z.infer<NonNullable<TEntry["data"]>>
    : never;

export type ServiceError<T extends ErrorSchema> = {
  [K in keyof T]: Prettify<{
    cause?: unknown;
    data?: ServiceErrorData<T[K]>;
    type: K & string;
  }>;
}[keyof T];

/**
 * oRPC error constructor map, keyed by error code. Structural supertype of the
 * `errors` object exposed inside a handler built from `procedure.errors(...)`.
 *
 * The `data` input uses `never` so this accepts oRPC's per-code constructors
 * (function params are contravariant: a constructor taking a specific `data`
 * shape is assignable where one taking `never` is expected).
 */
export type ErrorConstructorMap<T extends ErrorSchema> = {
  [K in keyof T]: (options: { data: never }) => Error;
};
