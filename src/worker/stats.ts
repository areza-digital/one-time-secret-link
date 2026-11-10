// Daily totals: how many one-time links and requests were created, requests filled and links opened, per UTC day.
// A counter is a day, a kind and a number. Nothing else ever reaches this file: no address, hash, id, label or header.

export const STAT_KINDS = ["send", "request", "fill", "open"] as const;
export type StatKind = (typeof STAT_KINDS)[number];

/** Days of history kept, today included. Older counters are deleted. */
export const STATS_DAYS = 400;
/** The RateLimiter object that holds the totals (the other objects are named after a hashed address, or "global"). */
export const STATS_OBJECT = "stats";

export interface DayTotals {
  day: string;
  send: number;
  request: number;
  fill: number;
  open: number;
}

/** The part of Durable Object storage the counters use. */
export interface CounterStore {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: number): Promise<void>;
  delete(keys: string[]): Promise<number>;
  list<T>(options: { start?: string; end?: string; limit?: number }): Promise<Map<string, T>>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Adds one to today's counter of a kind. The key is `<day>|<kind>`, the value a plain number. */
export async function addCount(store: CounterStore, kind: StatKind, now: number): Promise<void> {
  const key = `${day(now)}|${kind}`;
  const count = ((await store.get<number>(key)) ?? 0) + 1;
  await store.put(key, count);
  // First count of a kind each day: delete what has left the history window, at most 128 keys at a time.
  if (count === 1) {
    const old = await store.list<number>({ end: day(now - (STATS_DAYS - 1) * DAY_MS), limit: 128 });
    if (old.size) await store.delete([...old.keys()]);
  }
}

/** The last `days` days, newest first, zero where nothing was counted. */
export async function readTotals(store: CounterStore, days: number, now: number): Promise<DayTotals[]> {
  const rows = await store.list<number>({ start: day(now - (days - 1) * DAY_MS), limit: days * STAT_KINDS.length });
  return Array.from({ length: days }, (_, back) => {
    const date = day(now - back * DAY_MS);
    const [send, request, fill, open] = STAT_KINDS.map((kind) => rows.get(`${date}|${kind}`) ?? 0);
    return { day: date, send, request, fill, open };
  });
}
