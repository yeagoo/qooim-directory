import { HttpError } from "./operators.js";

// Per-process fixed-window limits for anonymous public reads (pages, search,
// catalog, sitemaps, badges). Kept in memory on purpose: a database row per page view
// would add the very load the limit is meant to bound. With several web
// processes each enforces its own window, which only loosens the limit.
export type ReadBucket = "search" | "list" | "page" | "sitemap" | "badge";
export const READ_LIMITS: Record<ReadBucket, number> = {
  search: 120,
  list: 240,
  page: 600,
  sitemap: 60,
  badge: 600,
};
const WINDOW_MS = 60_000,
  MAX_KEYS = 50_000;
export class ReadLimiter {
  private windows = new Map<string, { count: number; reset: number }>();
  constructor(
    private limits: Record<ReadBucket, number> = READ_LIMITS,
    private now: () => number = Date.now,
  ) {}
  consume(bucket: ReadBucket, site: string, client: string) {
    const now = this.now(),
      key = `${bucket}:${site}:${client}`;
    let window = this.windows.get(key);
    if (!window || window.reset <= now) {
      if (this.windows.size >= MAX_KEYS) this.prune(now);
      window = { count: 0, reset: now + WINDOW_MS };
      this.windows.set(key, window);
    }
    if (++window.count > this.limits[bucket])
      throw new HttpError(429, "请求过于频繁，请稍后再试");
  }
  private prune(now: number) {
    for (const [key, window] of this.windows)
      if (window.reset <= now) this.windows.delete(key);
    // Still full (a burst of distinct clients): drop the oldest tenth. Clearing
    // everything would let a flood of new keys reset every active window.
    if (this.windows.size >= MAX_KEYS) {
      let drop = Math.ceil(MAX_KEYS / 10);
      for (const key of this.windows.keys()) {
        if (drop-- <= 0) break;
        this.windows.delete(key);
      }
    }
  }
}
