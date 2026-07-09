/**
 * Price providers for the SOL/USD feed. Each returns raw [unixSeconds, price]
 * points for a time range; SolPriceFeed handles caching and lookups.
 */

export interface PriceProvider {
  /** Recorded in cache files, e.g. "binance:SOLUSDT@api.binance.com". */
  readonly id: string;
  /** Typical spacing between points, so callers can size boundary padding. */
  readonly granularitySec: number;
  fetchRange(fromSec: number, toSec: number): Promise<Array<[number, number]>>;
}

/**
 * The provider cannot serve this process at all (geo-block, unknown symbol,
 * exhausted retries) — the feed should move on to the next provider.
 */
export class ProviderUnavailableError extends Error {
  constructor(providerId: string, reason: string) {
    super(`${providerId}: ${reason}`);
    this.name = "ProviderUnavailableError";
  }
}

export interface ProviderHttpOptions {
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  maxRetries?: number;
  initialBackoffMs?: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface HttpDeps {
  fetchFn: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  maxRetries: number;
  initialBackoffMs: number;
}

function httpDeps(options: ProviderHttpOptions): HttpDeps {
  return {
    fetchFn: options.fetchFn ?? fetch,
    sleep: options.sleepFn ?? defaultSleep,
    maxRetries: options.maxRetries ?? 6,
    initialBackoffMs: options.initialBackoffMs ?? 1_000,
  };
}

/** Retries 429/418/5xx with backoff (honoring Retry-After); returns any other response. */
async function fetchWithRetry(
  deps: HttpDeps,
  url: URL,
  headers: Record<string, string>,
): Promise<Response> {
  let backoff = deps.initialBackoffMs;
  for (let attempt = 0; ; attempt++) {
    const response = await deps.fetchFn(url, { headers });
    const retryable =
      response.status === 429 || response.status === 418 || response.status >= 500;
    if (!retryable || attempt === deps.maxRetries) return response;

    const retryAfter = Number(response.headers.get("retry-after"));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : backoff + Math.random() * backoff * 0.25;
    await deps.sleep(delay);
    backoff = Math.min(backoff * 2, 60_000);
  }
}

export interface BinanceKlinesOptions extends ProviderHttpOptions {
  baseUrl?: string;
  symbol?: string;
}

/**
 * Binance public klines: true 1-minute candles for SOLUSDT back to 2020,
 * free, no API key. api.binance.com geo-blocks some regions (HTTP 451) —
 * construct a second instance against api.binance.us as a fallback.
 */
export class BinanceKlinesProvider implements PriceProvider {
  readonly id: string;
  readonly granularitySec = 60;
  private readonly baseUrl: string;
  private readonly symbol: string;
  private readonly deps: HttpDeps;

  constructor(options: BinanceKlinesOptions = {}) {
    this.baseUrl = options.baseUrl ?? "https://api.binance.com";
    this.symbol = options.symbol ?? "SOLUSDT";
    this.id = `binance:${this.symbol}@${new URL(this.baseUrl).host}`;
    this.deps = httpDeps(options);
  }

  async fetchRange(fromSec: number, toSec: number): Promise<Array<[number, number]>> {
    const points: Array<[number, number]> = [];
    let startMs = fromSec * 1000;
    const endMs = toSec * 1000;

    while (startMs < endMs) {
      const url = new URL("/api/v3/klines", this.baseUrl);
      url.searchParams.set("symbol", this.symbol);
      url.searchParams.set("interval", "1m");
      url.searchParams.set("startTime", String(startMs));
      url.searchParams.set("endTime", String(endMs));
      url.searchParams.set("limit", "1000");

      const response = await fetchWithRetry(this.deps, url, {});

      if (response.status === 451 || response.status === 403) {
        throw new ProviderUnavailableError(this.id, `blocked (HTTP ${response.status})`);
      }
      if (response.status === 400) {
        throw new ProviderUnavailableError(
          this.id,
          `rejected request (HTTP 400): ${(await response.text()).slice(0, 200)}`,
        );
      }
      if (!response.ok) {
        throw new ProviderUnavailableError(
          this.id,
          `failed (HTTP ${response.status}) after retries`,
        );
      }

      // Kline: [openTimeMs, open, high, low, close, volume, closeTimeMs, ...]
      const klines = (await response.json()) as Array<[number, string, string, string, string]>;
      if (klines.length === 0) break;
      for (const k of klines) {
        points.push([Math.round(k[0] / 1000), Number(k[4])]);
      }
      startMs = klines[klines.length - 1]![0] + 60_000;
      if (klines.length < 1000) break;
    }

    return points;
  }
}

export interface CoinGeckoOptions extends ProviderHttpOptions {
  baseUrl?: string;
  /** Optional demo key; the free tier works without one. */
  apiKey?: string;
  nowFn?: () => number;
}

/**
 * CoinGecko market_chart/range: 5-minute points for the last day, hourly for
 * older history on the free tier. Coarse but never geo-blocked — the last
 * resort in the provider chain.
 */
export class CoinGeckoProvider implements PriceProvider {
  readonly id = "coingecko:solana/market_chart/range";
  readonly granularitySec = 3_600;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly deps: HttpDeps;
  private readonly now: () => number;

  constructor(options: CoinGeckoOptions = {}) {
    this.baseUrl = options.baseUrl ?? "https://api.coingecko.com";
    this.apiKey = options.apiKey;
    this.deps = httpDeps(options);
    this.now = options.nowFn ?? (() => Math.floor(Date.now() / 1000));
  }

  async fetchRange(fromSec: number, toSec: number): Promise<Array<[number, number]>> {
    const url = new URL("/api/v3/coins/solana/market_chart/range", this.baseUrl);
    url.searchParams.set("vs_currency", "usd");
    url.searchParams.set("from", String(fromSec));
    url.searchParams.set("to", String(Math.min(toSec, this.now())));

    const headers: Record<string, string> = {};
    if (this.apiKey) headers["x-cg-demo-api-key"] = this.apiKey;

    const response = await fetchWithRetry(this.deps, url, headers);
    if (!response.ok) {
      throw new ProviderUnavailableError(
        this.id,
        `failed (HTTP ${response.status}): ${(await response.text()).slice(0, 200)}`,
      );
    }

    const body = (await response.json()) as { prices?: Array<[number, number]> };
    // CoinGecko timestamps are milliseconds.
    return (body.prices ?? []).map(([ms, price]) => [Math.round(ms / 1000), price]);
  }
}
