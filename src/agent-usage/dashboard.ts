import { dayKey, shiftDay } from "./core/daily-time.js";
import { emptyUsage } from "./core/usage.js";
import type { DashboardFilter, DashboardPage, UsageDashboard, UsageSessionTrend } from "./dashboard-types.js";
import type { UsageStore } from "./storage/usage-store.js";

/** Host Session/Run metadata joined to the existing ledger, inside the read-only query worker. */
export const readUsageDashboard = (store: UsageStore, filter: DashboardFilter): UsageDashboard => {
  const { db } = store;
  const scope = filter.agentId === undefined ? "1" : "s.agent_id=?";
  const agentParams = filter.agentId === undefined ? [] : [filter.agentId];
  const created = db.prepare(`SELECT date(s.created_at) AS day, COUNT(*) AS count FROM sessions s
    WHERE ${scope} AND s.created_at>=? AND s.created_at<? GROUP BY day`)
    .all(...agentParams, filter.from, filter.to) as Array<{ day: string; count: number }>;
  const activity = db.prepare(`SELECT date(r.started_at) AS day, COUNT(DISTINCT s.id) AS activeSessions, COUNT(*) AS runs
    FROM runs r JOIN sessions s ON s.id=r.session_id
    WHERE ${scope} AND r.started_at>=? AND r.started_at<? GROUP BY day`)
    .all(...agentParams, filter.from, filter.to) as Array<{ day: string; activeSessions: number; runs: number }>;
  const active = db.prepare(`SELECT COUNT(DISTINCT s.id) AS count FROM runs r JOIN sessions s ON s.id=r.session_id
    WHERE ${scope} AND r.started_at>=? AND r.started_at<?`)
    .get(...agentParams, filter.from, filter.to) as { count: number };
  const { summary, timeseries, reportedSessions } = store.overviewWithSessionCounts(filter);
  const usageByDay = new Map(timeseries.items.map(item => [item.period, item.usage]));
  const createdByDay = new Map(created.map(item => [item.day, item.count]));
  const activityByDay = new Map(activity.map(item => [item.day, item]));
  const daily: UsageDashboard["daily"] = [];
  for (let day = dayKey(filter.from); day < dayKey(filter.to); day = shiftDay(day, 1)) {
    const usage = usageByDay.get(day) ?? emptyUsage(), count = reportedSessions[day] ?? 0;
    daily.push({ day, usage, reportedSessions: count,
      averageTokensPerSession: count > 0 && usage.totalTokens !== null ? usage.totalTokens / count : null,
      newSessions: createdByDay.get(day) ?? 0,
      activeSessions: activityByDay.get(day)?.activeSessions ?? 0, runs: activityByDay.get(day)?.runs ?? 0 });
  }
  return { summary, unplacedUsage: timeseries.unplacedUsage, daily,
    counts: { newSessions: created.reduce((sum, row) => sum + row.count, 0), activeSessions: active.count,
      runs: activity.reduce((sum, row) => sum + row.runs, 0) } };
};

/** A creation-date cohort with bounded pagination. Each Session retains its full lifetime ledger total. */
export const readUsageSessionTrend = (store: UsageStore, filter: DashboardFilter, page: DashboardPage): UsageSessionTrend => {
  const scope = filter.agentId === undefined ? "1" : "s.agent_id=?";
  const params = [...(filter.agentId === undefined ? [] : [filter.agentId]), filter.from, filter.to];
  const where = `${scope} AND s.created_at>=? AND s.created_at<?`;
  const { total } = store.db.prepare(`SELECT COUNT(*) AS total FROM sessions s WHERE ${where}`).get(...params) as { total: number };
  const order = page.order === "desc" ? "DESC" : "ASC";
  const rows = store.db.prepare(`SELECT s.id AS sessionId, s.title, s.agent_id AS agentId, a.name AS agentName, s.created_at AS createdAt
    FROM sessions s JOIN agents a ON a.id=s.agent_id WHERE ${where} ORDER BY s.created_at ${order}, s.id ${order} LIMIT ? OFFSET ?`)
    .all(...params, page.limit, page.offset) as Array<Omit<UsageSessionTrend["items"][number], "summary">>;
  const summaries = store.summariesBySession(filter.namespace, rows.map(row => String(row.sessionId)));
  return { total, items: rows.map((row, index) => ({ ...row, summary: summaries[index]!.summary })) };
};
