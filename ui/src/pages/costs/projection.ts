/** Month-to-date spend scaled to the whole UTC month; null until anything was spent. */
export function projectedMonthEndCents(monthSpendCents: number, now: Date): number | null {
  if (monthSpendCents <= 0) return null;
  const day = now.getUTCDate();
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  return Math.round((monthSpendCents / day) * daysInMonth);
}
