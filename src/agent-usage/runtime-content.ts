import { UsageError } from "./core/errors.js";

/** Measurement happens before a transaction; only the prepared projection is committed. */
export type PreparedRuntimeContent = { commit(): void; pending?: boolean };

export const commitRuntimeContent = (prepared: PreparedRuntimeContent | undefined): void => {
  prepared?.commit();
  if (prepared?.pending) throw new UsageError("usage_tokenizer_pending");
};
