import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HeliusClient, HeliusRateLimitError } from "./heliusClient.js";
import type { HeliusParsedTransaction } from "./types.js";

const WALLET = "So11111111111111111111111111111111111111112";

function makeTx(n: number): HeliusParsedTransaction {
  return {
    signature: `sig${n}`,
    timestamp: 2_000_000_000 - n, // newest first, like the API returns
    slot: 1_000_000 - n,
    type: "TRANSFER",
    source: "SYSTEM_PROGRAM",
    fee: 5000,
    feePayer: WALLET,
    description: `tx ${n}`,
  };
}

/** Serves `total` transactions in pages, newest first, honoring `before`. */
function makeFakeApi(total: number) {
  const all = Array.from({ length: total }, (_, i) => makeTx(i));
  const calls: string[] = [];

  const fetchFn = vi.fn(async (input: URL | string) => {
    const url = new URL(String(input));
    calls.push(url.searchParams.get("before") ?? "HEAD");
    const limit = Number(url.searchParams.get("limit"));
    const before = url.searchParams.get("before");
    const start = before === null ? 0 : all.findIndex((tx) => tx.signature === before) + 1;
    const page = all.slice(start, start + limit);
    return new Response(JSON.stringify(page), { status: 200 });
  });

  return { fetchFn: fetchFn as unknown as typeof fetch, calls, all };
}

describe("HeliusClient.fetchHistory", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "soltax-helius-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeClient(fetchFn: typeof fetch, overrides: Record<string, unknown> = {}) {
    return new HeliusClient({
      apiKey: "test-key",
      cacheDir: dir,
      pageSize: 10,
      initialBackoffMs: 1,
      fetchFn,
      sleepFn: async () => {},
      ...overrides,
    });
  }

  it("paginates through the full history and caches everything", async () => {
    const api = makeFakeApi(35);
    const client = makeClient(api.fetchFn);

    const result = await client.fetchHistory(WALLET);

    expect(result.fetched).toBe(35);
    expect(result.total).toBe(35);
    // 35 txs at page size 10 → 3 full pages + 1 partial + 1 empty terminator
    expect(api.calls).toEqual(["HEAD", "sig9", "sig19", "sig29", "sig34"]);

    const signatures: string[] = [];
    for await (const tx of client.readHistory(WALLET)) {
      signatures.push(tx.signature);
    }
    expect(new Set(signatures).size).toBe(35);
  });

  it("never refetches: a second run stops at the first cached signature", async () => {
    const api = makeFakeApi(35);
    const client = makeClient(api.fetchFn);
    await client.fetchHistory(WALLET);
    api.calls.length = 0;

    const second = await client.fetchHistory(WALLET);

    expect(second.fetched).toBe(0);
    expect(second.total).toBe(35);
    // Only the head page is requested; it hits a cached signature immediately.
    expect(api.calls).toEqual(["HEAD"]);
  });

  it("picks up only new transactions added since the last run", async () => {
    const api = makeFakeApi(25);
    const client = makeClient(api.fetchFn);
    await client.fetchHistory(WALLET);

    // Five new transactions land at the head of history.
    const newer = Array.from({ length: 5 }, (_, i) => ({
      ...makeTx(-1 - i),
      signature: `new${i}`,
    })).reverse();
    api.all.unshift(...newer);
    api.calls.length = 0;

    const result = await client.fetchHistory(WALLET);

    expect(result.fetched).toBe(5);
    expect(result.total).toBe(30);
    expect(api.calls).toEqual(["HEAD"]);
  });

  it("resumes an interrupted backfill from the stored cursor", async () => {
    const api = makeFakeApi(35);

    // First run: the API dies after two pages.
    let pagesServed = 0;
    const flaky = vi.fn(async (input: URL | string) => {
      pagesServed += 1;
      if (pagesServed > 2) return new Response("boom", { status: 500 });
      return (api.fetchFn as unknown as (i: URL | string) => Promise<Response>)(input);
    }) as unknown as typeof fetch;

    const flakyClient = makeClient(flaky, { maxRetries: 0 });
    await expect(flakyClient.fetchHistory(WALLET)).rejects.toThrow(/status 500/);

    // Second run with a healthy API resumes from sig19, not from scratch.
    api.calls.length = 0;
    const client = makeClient(api.fetchFn);
    const result = await client.fetchHistory(WALLET);

    expect(result.total).toBe(35);
    expect(result.fetched).toBe(15);
    expect(api.calls[0]).toBe("HEAD"); // hits cached sig0 immediately
    expect(api.calls[1]).toBe("sig19"); // then resumes the backfill cursor
  });

  it("retries 429 responses with backoff and eventually succeeds", async () => {
    const api = makeFakeApi(5);
    let rateLimited = 0;
    const sleeps: number[] = [];

    const fetchFn = vi.fn(async (input: URL | string) => {
      if (rateLimited < 3) {
        rateLimited += 1;
        return new Response("slow down", { status: 429 });
      }
      return (api.fetchFn as unknown as (i: URL | string) => Promise<Response>)(input);
    }) as unknown as typeof fetch;

    const client = makeClient(fetchFn, {
      initialBackoffMs: 100,
      sleepFn: async (ms: number) => {
        sleeps.push(ms);
      },
    });

    const result = await client.fetchHistory(WALLET);
    expect(result.fetched).toBe(5);
    expect(sleeps).toHaveLength(3);
    // Exponential: each delay's base doubles (jitter adds up to 25%).
    expect(sleeps[0]).toBeGreaterThanOrEqual(100);
    expect(sleeps[0]).toBeLessThan(125);
    expect(sleeps[1]).toBeGreaterThanOrEqual(200);
    expect(sleeps[2]).toBeGreaterThanOrEqual(400);
  });

  it("honors Retry-After headers", async () => {
    const api = makeFakeApi(5);
    let first = true;
    const sleeps: number[] = [];

    const fetchFn = vi.fn(async (input: URL | string) => {
      if (first) {
        first = false;
        return new Response("slow down", {
          status: 429,
          headers: { "retry-after": "7" },
        });
      }
      return (api.fetchFn as unknown as (i: URL | string) => Promise<Response>)(input);
    }) as unknown as typeof fetch;

    const client = makeClient(fetchFn, {
      sleepFn: async (ms: number) => {
        sleeps.push(ms);
      },
    });

    await client.fetchHistory(WALLET);
    expect(sleeps).toEqual([7000]);
  });

  it("gives up with HeliusRateLimitError after exhausting retries", async () => {
    const fetchFn = vi.fn(
      async () => new Response("slow down", { status: 429 }),
    ) as unknown as typeof fetch;

    const client = makeClient(fetchFn, { maxRetries: 2 });
    await expect(client.fetchHistory(WALLET)).rejects.toThrow(HeliusRateLimitError);
    expect(fetchFn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("reports progress after each page", async () => {
    const api = makeFakeApi(25);
    const client = makeClient(api.fetchFn);
    const snapshots: number[] = [];

    await client.fetchHistory(WALLET, {
      onProgress: (p) => snapshots.push(p.fetched),
    });

    expect(snapshots).toEqual([10, 20, 25, 25]);
  });
});
