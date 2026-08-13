const canBeThenable = (value: unknown): value is Record<PropertyKey, unknown> | ((...args: unknown[]) => unknown) =>
  (typeof value === "object" && value !== null) || typeof value === "function";

/** Rejects async work while the caller still owns a synchronous SQLite transaction. */
export const assertSynchronousTransactionHook = (result: unknown): undefined => {
  if (!canBeThenable(result) || typeof (result as { then?: unknown }).then !== "function") return undefined;

  // Attach a rejection handler before throwing so an async/any implementation cannot
  // create an unhandled rejection after the synchronous transaction is rolled back.
  void Promise.resolve(result).catch(() => undefined);
  throw new Error("async_transaction_hook");
};
