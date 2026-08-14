import type {
  ErrorConstructorMap,
  ErrorSchema,
  ServiceError,
} from "./types.ts";

/**
 * Re-throws a service error through the matching oRPC typed-error constructor.
 *
 * Both `constructors` and `error` are derived from the same {@link ErrorSchema}
 * `T`, so the lookup is correct by construction. TypeScript cannot correlate a
 * union value's `type` with its `data` across an index access, so the single
 * cast here bridges that gap — it is the one intentional, localized assertion
 * instead of scattering casts at every call site.
 */
export const throwServiceError = <T extends ErrorSchema>(
  constructors: ErrorConstructorMap<T>,
  error: ServiceError<T>
): never => {
  const construct = constructors[error.type] as (options: {
    data: unknown;
  }) => Error;

  throw construct({ data: "data" in error ? error.data : undefined });
};
