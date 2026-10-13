import Database from "better-sqlite3";
import { UsageStore } from "./storage/usage-store.js";
import { AttributionStore } from "./storage/attribution-store.js";
import { usageQueryVersion } from "./storage/query-version.js";

export type UsageQueries = {
  overview: { args: Parameters<UsageStore["overview"]>; result: ReturnType<UsageStore["overview"]> };
  overviewWithContext: { args: Parameters<UsageStore["overview"]>; result: ReturnType<UsageStore["overview"]> & { contextAnalysis: ReturnType<AttributionStore["contextSummary"]> } };
  sessionSummaries: { args: Parameters<UsageStore["summariesBySession"]>; result: ReturnType<UsageStore["summariesBySession"]> };
  rankings: { args: Parameters<AttributionStore["rankingsPage"]>; result: ReturnType<AttributionStore["rankingsPage"]> };
  contextSummary: { args: Parameters<AttributionStore["contextSummary"]>; result: ReturnType<AttributionStore["contextSummary"]> };
  dailyRankingProjection: { args: Parameters<AttributionStore["dailyRankings"]["project"]>; result: ReturnType<AttributionStore["dailyRankings"]["project"]> };
  accountingProjection: { args: Parameters<UsageStore["projectEpoch"]>; result: ReturnType<UsageStore["projectEpoch"]> };
};
export type UsageQuerySnapshot<T> = { value: T; revision: string; asOf: string };
export type UsageQuery = { [K in keyof UsageQueries]: { kind: K; args: UsageQueries[K]["args"] } }[keyof UsageQueries];

export const executeUsageQuery = (store: UsageStore, attribution: AttributionStore, query: UsageQuery) => {
  if (query.kind === "overview") return store.overview(...query.args);
  if (query.kind === "overviewWithContext") return { ...store.overview(...query.args), contextAnalysis: attribution.contextSummary(query.args[0]) };
  if (query.kind === "sessionSummaries") return store.summariesBySession(...query.args);
  if (query.kind === "contextSummary") return attribution.contextSummary(...query.args);
  if (query.kind === "dailyRankingProjection") return attribution.dailyRankings.project(...query.args);
  if (query.kind === "accountingProjection") return store.projectEpoch(...query.args);
  return attribution.rankingsPage(...query.args);
};

/** Only these read operations cross the worker boundary; the connection cannot mutate or migrate. */
export const openUsageQueryReader = (filename: string) => {
  const db = new Database(filename, { readonly: true, fileMustExist: true, timeout: 1000 });
  db.pragma("cache_size=-8192");
  const store = new UsageStore(db), attribution = new AttributionStore(store);
  const read = db.transaction((query: UsageQuery) => executeUsageQuery(store,attribution,query));
  const readSnapshot = db.transaction((query: UsageQuery) => ({ revision: usageQueryVersion(db).revision,
    asOf: new Date().toISOString(), value: read(query) }));
  return { read, readSnapshot, close: () => db.close() };
};
