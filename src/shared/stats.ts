// The kinds of daily totals and how long they are kept. Shared so the CLI reads the same names as the Worker writes.

export const STAT_KINDS = ["send", "request", "fill", "open"] as const;
export type StatKind = (typeof STAT_KINDS)[number];

/** Days of history kept, today included. Older counters are deleted. */
export const STATS_DAYS = 400;
