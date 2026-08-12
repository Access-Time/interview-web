export function createContext(_options: { req: Request }) {
  return {};
}

export type Context = Awaited<ReturnType<typeof createContext>>;
