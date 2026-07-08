import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface PricePoint {
  /** Unix seconds of the candle/point the price came from. */
  atTimestamp: number;
  /** SOL/USD price. */
  price: number;
  /** Seconds between the requested time and the matched point. */
  distanceSec: number;
}

export interface SolPriceFeedOptions {
  cacheDir: string;
  /** Optional CoinGecko demo/pro key; free tier works without one. */
  apiKey?: string;
  baseUrl?: string;
  /**
   * Max seconds between requested time and nearest cached point before the
   * lookup returns null (caller should flag NEEDS_PRICE). CoinGecko's free
   * tier returns hourly points for history older than 90 days, so the
   * default allows ±45 minutes.
   */
  maxDistanceSec?: number;
  maxRetries?: number;
  initialBackoffMs?: number;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  nowFn?: () => number;
}

interface DayFile {
  day: string;
  source: string;
  /** [unixSeconds, price] pairs, ascending. */
  points: Array<[number, number]>;
  /**
   * A finished past day is immutable — once complete, it is never refetched.
   * Only the current (partial) day may be fetched again.
   */
  complete: boolean;
}

const DAY_SECONDS = 86_400;
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class SolPriceFeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SolPriceFeedError";
  }
}

/**
 * Historical SOL/USD prices from CoinGecko's market_chart/range endpoint,
 * cached to disk one file per UTC day.
 *
 * Granularity note: CoinGecko serves 5-minute points for the last day,
 * hourly for the last 90 days, and hourly-or-coarser beyond that on paid
 * tiers only. Lookups return the nearest point with its distance so callers
 * can decide whether the match is close enough; beyond maxDistanceSec the
 * lookup returns null rather than guessing.
 */
export class SolPriceFeed {
  private readonly cacheDir: string;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly maxDistanceSec: number;
  private readonly maxRetries: number;
  private readonly initialBackoffMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  /** Day files already loaded this run; avoids re-reading from disk. */
  private readonly loaded = new Map<string, DayFile>();

  constructor(options: SolPriceFeedOptions) {
    this.cacheDir = options.cacheDir;
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? "https://api.coingecko.com";
    this.maxDistanceSec = options.maxDistanceSec ?? 45 * 60;
    this.maxRetries = options.maxRetries ?? 6;
    this.initialBackoffMs = options.initialBackoffMs ?? 1_500;
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleep = options.sleepFn ?? defaultSleep;
    this.now = options.nowFn ?? (() => Math.floor(Date.now() / 1000));
  }

  /**
   * Nearest SOL/USD price to the given unix time, or null if no point lies
   * within maxDistanceSec (caller should flag NEEDS_PRICE, never guess).
   */
  async getPriceAt(unixSeconds: number): Promise<PricePoint | null> {
    if (unixSeconds > this.now() + 60) {
      throw new SolPriceFeedError(`refusing to price the future: ${unixSeconds}`);
    }

    // The nearest point may sit in the adjacent day right across midnight.
    const days = [dayOf(unixSeconds)];
    const secondsIntoDay = unixSeconds % DAY_SECONDS;
    if (secondsIntoDay < this.maxDistanceSec) days.push(dayOf(unixSeconds - DAY_SECONDS));
    if (DAY_SECONDS - secondsIntoDay < this.maxDistanceSec) days.push(dayOf(unixSeconds + DAY_SECONDS));

    let best: PricePoint | null = null;
    for (const day of days) {
      const file = await this.ensureDay(day);
      for (const [ts, price] of file.points) {
        const distanceSec = Math.abs(ts - unixSeconds);
        if (best === null || distanceSec < best.distanceSec) {
          best = { atTimestamp: ts, price, distanceSec };
        }
      }
    }
    return best !== null && best.distanceSec <= this.maxDistanceSec ? best : null;
  }

  /** Loads a UTC day's prices, fetching from CoinGecko only when needed. */
  private async ensureDay(day: string): Promise<DayFile> {
    const cached = this.loaded.get(day);
    if (cached?.complete) return cached;

    const path = join(this.cacheDir, `${day}.json`);
    if (!cached) {
      try {
        const fromDisk = JSON.parse(await readFile(path, "utf8")) as DayFile;
        this.loaded.set(day, fromDisk);
        if (fromDisk.complete) return fromDisk;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }

    const dayStart = Date.parse(`${day}T00:00:00Z`) / 1000;
    const dayEnd = dayStart + DAY_SECONDS;
    // Pad an hour each side so nearest-neighbor works at day boundaries
    // even when CoinGecko returns hourly points.
    const points = await this.fetchRange(dayStart - 3600, dayEnd + 3600);
    const file: DayFile = {
      day,
      source: "coingecko:solana/market_chart/range",
      points: points.filter(([ts]) => ts >= dayStart - 3600 && ts < dayEnd + 3600),
      // A day that has fully elapsed is done forever; today keeps refreshing.
      complete: dayEnd <= this.now(),
    };

    await mkdir(this.cacheDir, { recursive: true });
    const tmp = path + ".tmp";
    await writeFile(tmp, JSON.stringify(file), "utf8");
    await rename(tmp, path);
    this.loaded.set(day, file);
    return file;
  }

  private async fetchRange(from: number, to: number): Promise<Array<[number, number]>> {
    const url = new URL("/api/v3/coins/solana/market_chart/range", this.baseUrl);
    url.searchParams.set("vs_currency", "usd");
    url.searchParams.set("from", String(from));
    url.searchParams.set("to", String(Math.min(to, this.now())));

    const headers: Record<string, string> = {};
    if (this.apiKey) headers["x-cg-demo-api-key"] = this.apiKey;

    let backoff = this.initialBackoffMs;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const response = await this.fetchFn(url, { headers });

      if (response.status === 429 || response.status >= 500) {
        if (attempt === this.maxRetries) {
          throw new SolPriceFeedError(
            `CoinGecko still failing (${response.status}) after ${this.maxRetries} retries`,
          );
        }
        const retryAfter = Number(response.headers.get("retry-after"));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : backoff + Math.random() * backoff * 0.25;
        await this.sleep(delay);
        backoff = Math.min(backoff * 2, 60_000);
        continue;
      }

      if (!response.ok) {
        throw new SolPriceFeedError(
          `CoinGecko request failed with status ${response.status}: ${(await response.text()).slice(0, 200)}`,
        );
      }

      const body = (await response.json()) as { prices?: Array<[number, number]> };
      // CoinGecko timestamps are milliseconds.
      return (body.prices ?? []).map(([ms, price]) => [Math.round(ms / 1000), price]);
    }

    throw new SolPriceFeedError("unreachable retry loop exit");
  }
}

function dayOf(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}
