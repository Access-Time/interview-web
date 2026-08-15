export function createContext(options: { req?: Request } = {}) {
  return { req: options.req };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
