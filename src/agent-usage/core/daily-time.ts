/** One UTC calendar for management queries, trends and persisted daily projections. */
export const dayKey = (timestamp: string | null): string => timestamp === null ? "" : new Date(timestamp).toISOString().slice(0, 10);

export const shiftDay = (day: string, amount: number): string => {
  const value = new Date(`${day}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
};

export const dayStart = (day: string): string => `${day}T00:00:00.000Z`;

/** Inclusive first day; an already aligned exclusive end stays exclusive. */
export const dailyBounds = (from: string | undefined, to: string | undefined): { from?: string; to?: string } => ({
  ...(from === undefined ? {} : { from: dayStart(dayKey(from)) }),
  ...(to === undefined ? {} : { to: dayStart(shiftDay(dayKey(to),
    dayStart(dayKey(to)) === new Date(to).toISOString() ? 0 : 1)) })
});
