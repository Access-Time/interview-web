export interface FinalizerDispatcher {
  fetch: (request: Request) => Promise<Response>;
}

export async function dispatchFinalization(
  finalizer: FinalizerDispatcher,
  sessionId: string
): Promise<void> {
  const response = await finalizer.fetch(
    new Request("https://finalizer/internal/finalizations", {
      body: JSON.stringify({ sessionId }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
  );
  if (!response.ok) {
    throw new Error("Finalization dispatch failed");
  }
}
