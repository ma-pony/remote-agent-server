/** Calendar boundaries shared by management queries and persisted daily projections. */
// Triggers repeatedly visit the same timestamp/day; bound these process-local caches.
const days = new Map<string, string>(), boundaries = new Map<string, string>();
const remember = (cache: Map<string, string>, key: string, value: string): string => {
  if (cache.size >= 4096) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
  return value;
};
const formatters = new Map<string, Intl.DateTimeFormat>();
const parts = (instant: Date, timezone: string): Record<string, string> => {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    formatters.set(timezone, formatter);
  }
  return Object.fromEntries(formatter.formatToParts(instant).map(part => [part.type, part.value]));
};

export const localDay = (timestamp: string | null, timezone: string): string => {
  if (timestamp === null) return "";
  const key = `${timezone}:${timestamp}`, cached = days.get(key);
  if (cached !== undefined) return cached;
  const value = parts(new Date(timestamp), timezone);
  return remember(days, key, `${value.year}-${value.month}-${value.day}`);
};

export const shiftDay = (day: string, amount: number): string => {
  const value = new Date(`${day}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
};

export const dayStart = (day: string, timezone: string): string => {
  const key = `${timezone}:${day}`, cached = boundaries.get(key);
  if (cached !== undefined) return cached;
  const target = Date.parse(`${day}T00:00:00.000Z`);
  let instant = target;
  for (let attempt = 0; attempt < 4; attempt++) {
    const value = parts(new Date(instant), timezone);
    const represented = Date.UTC(Number(value.year), Number(value.month) - 1, Number(value.day),
      Number(value.hour), Number(value.minute), Number(value.second));
    const correction = target - represented;
    if (!correction) {
      // A repeated midnight is not necessarily the first instant of this date.
      if (localDay(new Date(instant - 1).toISOString(), timezone) < day)
        return remember(boundaries, key, new Date(instant).toISOString());
      break;
    }
    instant += correction;
  }
  // Find the first instant when midnight repeats or is skipped (or the following
  // date when an entire calendar day is skipped).
  let low = target - 36 * 3_600_000, high = target + 36 * 3_600_000;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (localDay(new Date(middle).toISOString(), timezone) < day) low = middle;
    else high = middle;
  }
  return remember(boundaries, key, new Date(high).toISOString());
};

/** Inclusive first day; an already aligned exclusive end stays exclusive. */
export const dailyBounds = (from: string | undefined, to: string | undefined, timezone: string): { from?: string; to?: string } => ({
  ...(from === undefined ? {} : { from: dayStart(localDay(from, timezone), timezone) }),
  ...(to === undefined ? {} : { to: dayStart(shiftDay(localDay(to, timezone),
    dayStart(localDay(to, timezone), timezone) === new Date(to).toISOString() ? 0 : 1), timezone) })
});
