import type { UsageFilter, UsageMetrics, UsageSummary } from "./core/types.js";

export type DashboardFilter = Pick<UsageFilter, "agentId"> & { namespace: string; from: string; to: string };
export type DashboardPage = { limit: number; offset: number; order?: "asc" | "desc" };
export type DashboardSnapshot<T> = T & { asOf: string; from: string; to: string; timeZone: "UTC" };
export type UsageDashboard = {
  summary: UsageSummary;
  unplacedUsage: UsageMetrics;
  counts: { newSessions: number; activeSessions: number; runs: number };
  daily: Array<{ day: string; usage: UsageMetrics; newSessions: number; activeSessions: number; runs: number;
    reportedSessions: number; averageTokensPerSession: number | null }>;
};
export type UsageSessionTrend = {
  total: number;
  items: Array<{ sessionId: number; title: string; agentId: number; agentName: string; createdAt: string; summary: UsageSummary }>;
};
