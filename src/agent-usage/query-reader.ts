import Database from "better-sqlite3";
import { UsageStore } from "./storage/usage-store.js";
import { AttributionStore } from "./storage/attribution-store.js";

export type UsageQueries = {
  overview: { args: Parameters<UsageStore["overview"]>; result: ReturnType<UsageStore["overview"]> };
  sessionSummaries: { args: Parameters<UsageStore["summariesBySession"]>; result: ReturnType<UsageStore["summariesBySession"]> };
  rankings: { args: Parameters<AttributionStore["rankingsPage"]>; result: ReturnType<AttributionStore["rankingsPage"]> };
};
export type UsageQuery = { [K in keyof UsageQueries]: { kind: K; args: UsageQueries[K]["args"] } }[keyof UsageQueries];

/** Only these read operations cross the worker boundary; the connection cannot mutate or migrate. */
export const openUsageQueryReader = (filename: string) => {
  const db = new Database(filename, { readonly: true, fileMustExist: true, timeout: 1000 });
  db.pragma("cache_size=-8192");
  const store = new UsageStore(db), attribution = new AttributionStore(store);
  const read = db.transaction((query: UsageQuery) => query.kind === "overview"
    ? store.overview(...query.args) : query.kind === "sessionSummaries"
      ? store.summariesBySession(...query.args) : attribution.rankingsPage(...query.args));
  return { read, close: () => db.close() };
};
