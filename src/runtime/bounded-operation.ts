export const BEST_EFFORT_TIMEOUT_MS = 1_000;

export type BestEffortOutcome =
  | { status: "fulfilled" }
  | { status: "rejected"; reason: unknown }
  | { status: "timed_out"; reason: Error };

/**
 * Waits a fixed time for cleanup work without keeping the Node process alive.
 */
export const settleBestEffort = async (
  operation: () => PromiseLike<unknown>,
  timeoutMs = BEST_EFFORT_TIMEOUT_MS
): Promise<BestEffortOutcome> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operationOutcome = Promise.resolve()
    .then(operation)
    .then<BestEffortOutcome, BestEffortOutcome>(
      () => ({ status: "fulfilled" }),
      (reason: unknown) => ({ status: "rejected", reason })
    );
  const timeoutOutcome = new Promise<BestEffortOutcome>((resolve) => {
    timer = setTimeout(() => resolve({
      status: "timed_out",
      reason: new Error(`Best-effort operation timed out after ${timeoutMs}ms`)
    }), timeoutMs);
    timer.unref?.();
  });

  try {
    return await Promise.race([operationOutcome, timeoutOutcome]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};
