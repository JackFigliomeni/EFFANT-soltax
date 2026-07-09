import { describe, expect, it, vi } from "vitest";
import {
  BinanceKlinesProvider,
  CoinGeckoProvider,
  ProviderUnavailableError,
} from "./providers.js";

const DAY_START = Date.parse("2025-06-15T00:00:00Z") / 1000;

describe("BinanceKlinesProvider", () => {
  /** Serves 1m candles; close price encodes the minute index for assertions. */
  function makeFakeBinance() {
    const calls: Array<{ start: number; end: number; limit: number }> = [];
    const fetchFn = vi.fn(async (input: URL | string) => {
      const url = new URL(String(input));
      const start = Number(url.searchParams.get("startTime"));
      const end = Number(url.searchParams.get("endTime"));
      const limit = Number(url.searchParams.get("limit"));
      calls.push({ start, end, limit });
      const klines: unknown[] = [];
      for (let t = start, i = 0; t < end && i < limit; t += 60_000, i++) {
        const minute = Math.floor(t / 60_000);
        klines.push([t, "1", "2", "0.5", String(100 + (minute % 60)), "999", t + 59_999]);
      }
      return new Response(JSON.stringify(klines), { status: 200 });
    });
    return { fetchFn: fetchFn as unknown as typeof fetch, calls };
  }

  it("pages through a full day in 1000-candle chunks and parses closes", async () => {
    const api = makeFakeBinance();
    const provider = new BinanceKlinesProvider({ fetchFn: api.fetchFn });

    const points = await provider.fetchRange(DAY_START, DAY_START + DAY_SECONDS());

    expect(points.length).toBe(1440);
    // 1440 minutes at limit 1000 → two requests.
    expect(api.calls.length).toBe(2);
    expect(api.calls[1]!.start).toBe((DAY_START + 1000 * 60) * 1000);
    // Points are [unixSeconds, closePrice].
    expect(points[0]![0]).toBe(DAY_START);
    expect(typeof points[0]![1]).toBe("number");
  });

  it("throws ProviderUnavailableError on geo-block (451)", async () => {
    const fetchFn = vi.fn(async () => new Response("blocked", { status: 451 })) as unknown as typeof fetch;
    const provider = new BinanceKlinesProvider({ fetchFn });
    await expect(provider.fetchRange(DAY_START, DAY_START + 3600)).rejects.toThrow(
      ProviderUnavailableError,
    );
  });

  it("retries 429 then succeeds", async () => {
    const api = makeFakeBinance();
    let limited = true;
    const fetchFn = vi.fn(async (input: URL | string) => {
      if (limited) {
        limited = false;
        return new Response("slow down", { status: 429, headers: { "retry-after": "1" } });
      }
      return (api.fetchFn as unknown as (i: URL | string) => Promise<Response>)(input);
    }) as unknown as typeof fetch;
    const sleeps: number[] = [];
    const provider = new BinanceKlinesProvider({
      fetchFn,
      sleepFn: async (ms) => { sleeps.push(ms); },
    });

    const points = await provider.fetchRange(DAY_START, DAY_START + 3600);
    expect(points.length).toBe(60);
    expect(sleeps).toEqual([1000]);
  });

  it("gives up as unavailable after exhausting retries on 5xx", async () => {
    const fetchFn = vi.fn(async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const provider = new BinanceKlinesProvider({ fetchFn, maxRetries: 1, sleepFn: async () => {} });
    await expect(provider.fetchRange(DAY_START, DAY_START + 3600)).rejects.toThrow(
      ProviderUnavailableError,
    );
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe("CoinGeckoProvider", () => {
  it("converts millisecond timestamps to seconds", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(
        JSON.stringify({ prices: [[DAY_START * 1000, 150.5], [(DAY_START + 3600) * 1000, 151]] }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const provider = new CoinGeckoProvider({ fetchFn });

    const points = await provider.fetchRange(DAY_START, DAY_START + 7200);
    expect(points).toEqual([[DAY_START, 150.5], [DAY_START + 3600, 151]]);
  });

  it("sends the demo API key header when configured", async () => {
    let seenKey: string | null = null;
    const fetchFn = vi.fn(async (_i: URL | string, init?: RequestInit) => {
      seenKey = (init?.headers as Record<string, string>)["x-cg-demo-api-key"] ?? null;
      return new Response(JSON.stringify({ prices: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const provider = new CoinGeckoProvider({ fetchFn, apiKey: "demo-key" });
    await provider.fetchRange(DAY_START, DAY_START + 60);
    expect(seenKey).toBe("demo-key");
  });

  it("throws ProviderUnavailableError on non-ok responses", async () => {
    const fetchFn = vi.fn(async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    const provider = new CoinGeckoProvider({ fetchFn });
    await expect(provider.fetchRange(DAY_START, DAY_START + 60)).rejects.toThrow(
      ProviderUnavailableError,
    );
  });
});

function DAY_SECONDS(): number {
  return 86_400;
}
