export type ServiceResult<TData, TError> =
  | { data: TData; ok: true }
  | { error: TError; ok: false };

export const ok = <TData>(data: TData): ServiceResult<TData, never> => ({
  data,
  ok: true,
});

export const err = <const TError>(
  error: TError
): ServiceResult<never, TError> => ({
  error,
  ok: false,
});
