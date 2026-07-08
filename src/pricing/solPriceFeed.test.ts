import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SolPriceFeed, SolPriceFeedError } from "./solPriceFeed.js";

// 2025-06-15T00:00:00Z — a full UTC day well in the past relative to NOW.
const DAY_START = Date.parse("2025-06-15T00:00:00Z") / 1000;
const NOW = Date.parse("2025-07-01T12:00:00Z") / 1000;

/** Serves hourly candles: price = 100 + hours-since-epoch-hour, deterministic. */
function makeFakeCoinGecko() {
  const calls: Array<{ from: number; to: number }> = [];
  const fetchFn = vi.fn(async (input: URL | string) => {
    const url = new URL(String(input));
    const from = Number(url.searchParams.get("from"));
    const to = Number(url.searchParams.get("to"));
    calls.push({ from, to });
    const prices: Array<[number, number]> = [];
    const firstHour = Math.ceil(from / 3600) * 3600;
    for (let ts = firstHour; ts <= to; ts += 3600) {
      prices.push([ts * 1000, 100 + (ts / 3600) % 24]);
    }
    return new Response(JSON.stringify({ prices }), { status: 200 });
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

describe("SolPriceFeed", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "soltax-prices-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeFeed(fetchFn: typeof fetch, overrides: Record<string, unknown> = {}) {
    return new SolPriceFeed({
      cacheDir: dir,
      fetchFn,
      sleepFn: async () => {},
      nowFn: () => NOW,
      initialBackoffMs: 1,
      ...overrides,
    });
  }

  it("returns the nearest point with its distance", async () => {
    const api = makeFakeCoinGecko();
    const feed = makeFeed(api.fetchFn);

    // 10:20 UTC — nearest hourly candle is 10:00 (1200s away).
    const point = await feed.getPriceAt(DAY_START + 10 * 3600 + 20 * 60);

    expect(point).not.toBeNull();
    expect(point!.atTimestamp).toBe(DAY_START + 10 * 3600);
    expect(point!.distanceSec).toBe(1200);
    expect(point!.price).toBeCloseTo(100 + ((DAY_START / 3600) + 10) % 24, 9);
  });

  it("caches a completed day and never refetches it", async () => {
    const api = makeFakeCoinGecko();
    const feed = makeFeed(api.fetchFn);
    await feed.getPriceAt(DAY_START + 3600);
    expect(api.calls).toHaveLength(1);

    // Same day, different time, same feed: served from memory.
    await feed.getPriceAt(DAY_START + 7 * 3600);
    expect(api.calls).toHaveLength(1);

    // Fresh feed instance: served from disk, still no fetch.
    const feed2 = makeFeed(api.fetchFn);
    await feed2.getPriceAt(DAY_START + 12 * 3600);
    expect(api.calls).toHaveLength(1);

    const files = await readdir(dir);
    expect(files).toEqual(["2025-06-15.json"]);
    const file = JSON.parse(await readFile(join(dir, files[0]!), "utf8"));
    expect(file.complete).toBe(true);
  });

  it("marks the current (partial) day incomplete so it can refresh", async () => {
    const api = makeFakeCoinGecko();
    const feed = makeFeed(api.fetchFn);

    await feed.getPriceAt(NOW - 2 * 3600); // today, relative to NOW
    const files = await readdir(dir);
    const file = JSON.parse(await readFile(join(dir, files[0]!), "utf8"));
    expect(file.complete).toBe(false);

    // A new instance refetches an incomplete day.
    const feed2 = makeFeed(api.fetchFn);
    await feed2.getPriceAt(NOW - 2 * 3600);
    expect(api.calls.length).toBe(2);
  });

  it("returns null when the nearest point is too far away", async () => {
    // API with a single point 2h from the request.
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ prices: [[(DAY_START + 12 * 3600) * 1000, 150]] }), { status: 200 }),
    ) as unknown as typeof fetch;
    const feed = makeFeed(fetchFn);

    expect(await feed.getPriceAt(DAY_START + 14 * 3600)).toBeNull();
    // Within tolerance it resolves.
    const near = await feed.getPriceAt(DAY_START + 12 * 3600 + 600);
    expect(near?.price).toBe(150);
  });

  it("checks the adjacent day across midnight", async () => {
    const api = makeFakeCoinGecko();
    const feed = makeFeed(api.fetchFn);

    // 00:05 — nearest candle could be 00:00 same day; ensure both days load without error.
    const point = await feed.getPriceAt(DAY_START + 300);
    expect(point).not.toBeNull();
    expect(point!.distanceSec).toBe(300);
  });

  it("retries 429s with backoff and honors Retry-After", async () => {
    const api = makeFakeCoinGecko();
    const sleeps: number[] = [];
    let limited = 2;
    const fetchFn = vi.fn(async (input: URL | string) => {
      if (limited > 0) {
        limited -= 1;
        return new Response("rate limited", { status: 429, headers: { "retry-after": "3" } });
      }
      return (api.fetchFn as unknown as (i: URL | string) => Promise<Response>)(input);
    }) as unknown as typeof fetch;

    const feed = makeFeed(fetchFn, { sleepFn: async (ms: number) => { sleeps.push(ms); } });
    const point = await feed.getPriceAt(DAY_START + 3600);
    expect(point).not.toBeNull();
    expect(sleeps).toEqual([3000, 3000]);
  });

  it("gives up after exhausting retries", async () => {
    const fetchFn = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const feed = makeFeed(fetchFn, { maxRetries: 1 });
    await expect(feed.getPriceAt(DAY_START)).rejects.toThrow(SolPriceFeedError);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("refuses to price the future", async () => {
    const api = makeFakeCoinGecko();
    const feed = makeFeed(api.fetchFn);
    await expect(feed.getPriceAt(NOW + 3600)).rejects.toThrow(/future/);
  });
});
