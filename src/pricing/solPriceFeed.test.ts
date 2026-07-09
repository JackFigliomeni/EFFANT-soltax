import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderUnavailableError, type PriceProvider } from "./providers.js";
import { SolPriceFeed, SolPriceFeedError } from "./solPriceFeed.js";

// 2025-06-15T00:00:00Z — a full UTC day well in the past relative to NOW.
const DAY_START = Date.parse("2025-06-15T00:00:00Z") / 1000;
const NOW = Date.parse("2025-07-01T12:00:00Z") / 1000;

/** Minute-granularity fake provider; price encodes the minute for assertions. */
function makeMinuteProvider(id = "fake:minute") {
  const calls: Array<{ from: number; to: number }> = [];
  const provider: PriceProvider = {
    id,
    granularitySec: 60,
    async fetchRange(from, to) {
      calls.push({ from, to });
      const points: Array<[number, number]> = [];
      const first = Math.ceil(from / 60) * 60;
      for (let ts = first; ts <= to; ts += 60) points.push([ts, 100 + (ts / 60) % 60]);
      return points;
    },
  };
  return { provider, calls };
}

function makeUnavailableProvider(id: string) {
  const calls: number[] = [];
  const provider: PriceProvider = {
    id,
    granularitySec: 60,
    async fetchRange() {
      calls.push(1);
      throw new ProviderUnavailableError(id, "blocked (HTTP 451)");
    },
  };
  return { provider, calls };
}

describe("SolPriceFeed", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "soltax-prices-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeFeed(providers: PriceProvider[], overrides: Record<string, unknown> = {}) {
    return new SolPriceFeed({
      cacheDir: dir,
      providers,
      nowFn: () => NOW,
      ...overrides,
    });
  }

  it("returns the nearest minute point with its distance", async () => {
    const { provider } = makeMinuteProvider();
    const feed = makeFeed([provider]);

    // 10:20:25 — nearest minute candle is 10:20 (25s away).
    const point = await feed.getPriceAt(DAY_START + 10 * 3600 + 20 * 60 + 25);

    expect(point).not.toBeNull();
    expect(point!.atTimestamp).toBe(DAY_START + 10 * 3600 + 20 * 60);
    expect(point!.distanceSec).toBe(25);
  });

  it("caches a completed day and never calls a provider for it again", async () => {
    const { provider, calls } = makeMinuteProvider();
    const feed = makeFeed([provider]);
    await feed.getPriceAt(DAY_START + 3600);
    expect(calls).toHaveLength(1);

    // Same day, same feed: memory. New feed: disk. No provider calls.
    await feed.getPriceAt(DAY_START + 7 * 3600);
    const feed2 = makeFeed([provider]);
    await feed2.getPriceAt(DAY_START + 12 * 3600);
    expect(calls).toHaveLength(1);

    const files = await readdir(dir);
    expect(files).toEqual(["2025-06-15.json"]);
    const file = JSON.parse(await readFile(join(dir, files[0]!), "utf8"));
    expect(file.complete).toBe(true);
    expect(file.source).toBe("fake:minute");
    expect(file.points.length).toBeGreaterThan(1400); // real minute coverage
  });

  it("falls through the provider chain and records the winning source", async () => {
    const blocked = makeUnavailableProvider("binance:SOLUSDT@api.binance.com");
    const blockedUs = makeUnavailableProvider("binance:SOLUSDT@api.binance.us");
    const { provider: fallback } = makeMinuteProvider("coingecko:fallback");
    const feed = makeFeed([blocked.provider, blockedUs.provider, fallback]);

    const point = await feed.getPriceAt(DAY_START + 3600);
    expect(point).not.toBeNull();
    expect(blocked.calls).toHaveLength(1);
    expect(blockedUs.calls).toHaveLength(1);

    const file = JSON.parse(await readFile(join(dir, "2025-06-15.json"), "utf8"));
    expect(file.source).toBe("coingecko:fallback");
  });

  it("throws with all failure reasons when every provider is unavailable", async () => {
    const a = makeUnavailableProvider("provider-a");
    const b = makeUnavailableProvider("provider-b");
    const feed = makeFeed([a.provider, b.provider]);

    await expect(feed.getPriceAt(DAY_START)).rejects.toThrow(/provider-a.*provider-b/s);
  });

  it("marks the current (partial) day incomplete so it can refresh", async () => {
    const { provider, calls } = makeMinuteProvider();
    const feed = makeFeed([provider]);

    await feed.getPriceAt(NOW - 2 * 3600); // today, relative to NOW
    const files = await readdir(dir);
    const file = JSON.parse(await readFile(join(dir, files[0]!), "utf8"));
    expect(file.complete).toBe(false);

    // A new instance refetches an incomplete day.
    const feed2 = makeFeed([provider]);
    await feed2.getPriceAt(NOW - 2 * 3600);
    expect(calls.length).toBe(2);
    // Provider was never asked for future data.
    for (const c of calls) expect(c.to).toBeLessThanOrEqual(NOW);
  });

  it("returns null when the nearest point is too far away", async () => {
    const sparse: PriceProvider = {
      id: "fake:sparse",
      granularitySec: 60,
      async fetchRange() {
        return [[DAY_START + 12 * 3600, 150]];
      },
    };
    const feed = makeFeed([sparse]);

    expect(await feed.getPriceAt(DAY_START + 14 * 3600)).toBeNull();
    const near = await feed.getPriceAt(DAY_START + 12 * 3600 + 600);
    expect(near?.price).toBe(150);
  });

  it("checks the adjacent day across midnight", async () => {
    const { provider } = makeMinuteProvider();
    const feed = makeFeed([provider]);

    const point = await feed.getPriceAt(DAY_START + 30);
    expect(point).not.toBeNull();
    expect(point!.distanceSec).toBeLessThanOrEqual(30);
  });

  it("refuses to price the future", async () => {
    const { provider } = makeMinuteProvider();
    const feed = makeFeed([provider]);
    await expect(feed.getPriceAt(NOW + 3600)).rejects.toThrow(SolPriceFeedError);
  });
});
