// Fixed-window counters. One object per hashed client IP, plus one "global" object for the hourly cap, plus one
// "stats" object that holds the daily totals (stats.ts), so that no new binding or migration is needed.

import { DurableObject } from "cloudflare:workers";
import { addCount, readTotals, type DayTotals, type StatKind } from "./stats";

const CLEANUP_MS = 60 * 60 * 1000;

export class RateLimiter extends DurableObject {
  /** Counts one hit and says whether it is still within the limit. */
  async hit(bucket: string, limit: number, windowSeconds: number): Promise<boolean> {
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const windowEnd = Math.floor(now / windowMs) * windowMs + windowMs;
    const key = `${bucket}|${windowEnd}`;
    const count = (await this.ctx.storage.get<number>(key)) ?? 0;
    if (count >= limit) return false; // over the limit: no more writes, so a flood costs reads only
    await this.ctx.storage.put(key, count + 1);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(now + CLEANUP_MS);
    return true;
  }

  /** Daily totals, only ever called on the "stats" object. The kind is the whole input. */
  async tally(kind: StatKind): Promise<void> {
    await addCount(this.ctx.storage, kind, Date.now());
  }

  async totals(days: number): Promise<DayTotals[]> {
    return readTotals(this.ctx.storage, days, Date.now());
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const entries = await this.ctx.storage.list<number>();
    const expired = [...entries.keys()].filter((key) => Number(key.split("|")[1]) <= now);
    if (expired.length) await this.ctx.storage.delete(expired);
    if (entries.size > expired.length) await this.ctx.storage.setAlarm(now + CLEANUP_MS);
  }
}
