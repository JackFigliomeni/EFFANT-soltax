import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BinanceKlinesProvider,
  CoinGeckoProvider,
  ProviderUnavailableError,
  type PriceProvider,
} from "./providers.js";

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
  /**
   * Ordered provider chain; the first one that can serve a day wins.
   * Defaults to Binance 1-minute klines, then Binance.US (for geo-blocked
   * regions), then CoinGecko (hourly, never blocked).
   */
  providers?: PriceProvider[];
  /** Optional CoinGecko demo key for the fallback provider. */
  coinGeckoApiKey?: string;
  /**
   * Max seconds between requested time and nearest cached point before the
   * lookup returns null (caller should flag NEEDS_PRICE). Binance minute
   * data lands within ±30s; the default of 45 minutes only comes into play
   * when a day was cached from the hourly CoinGecko fallback.
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
  /** Provider id the points came from. */
  source: string;
  /** [unixSeconds, price] pairs, ascending. */
  points: Array<[number, number]>;
  /**
   * A finished past day is immutable — once complete, it is never refetched,
   * whichever provider filled it. Only the current (partial) day refreshes.
   */
  complete: boolean;
}

const DAY_SECONDS = 86_400;

export class SolPriceFeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SolPriceFeedError";
  }
}

/**
 * Historical SOL/USD prices cached to disk one file per UTC day.
 *
 * Data comes from an ordered provider chain (Binance minute klines first,
 * CoinGecko hourly as the last resort). Lookups return the nearest point
 * with its distance so callers can judge the match; beyond maxDistanceSec
 * the lookup returns null rather than guessing.
 */
export class SolPriceFeed {
  private readonly cacheDir: string;
  private readonly providers: PriceProvider[];
  private readonly maxDistanceSec: number;
  private readonly now: () => number;
  /** Day files already loaded this run; avoids re-reading from disk. */
  private readonly loaded = new Map<string, DayFile>();

  constructor(options: SolPriceFeedOptions) {
    this.cacheDir = options.cacheDir;
    this.maxDistanceSec = options.maxDistanceSec ?? 45 * 60;
    this.now = options.nowFn ?? (() => Math.floor(Date.now() / 1000));

    const http = {
      ...(options.fetchFn !== undefined && { fetchFn: options.fetchFn }),
      ...(options.sleepFn !== undefined && { sleepFn: options.sleepFn }),
      ...(options.maxRetries !== undefined && { maxRetries: options.maxRetries }),
      ...(options.initialBackoffMs !== undefined && {
        initialBackoffMs: options.initialBackoffMs,
      }),
    };
    this.providers = options.providers ?? [
      new BinanceKlinesProvider({ ...http }),
      new BinanceKlinesProvider({ ...http, baseUrl: "https://api.binance.us" }),
      new CoinGeckoProvider({
        ...http,
        nowFn: this.now,
        ...(options.coinGeckoApiKey !== undefined && { apiKey: options.coinGeckoApiKey }),
      }),
    ];
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

  /** Loads a UTC day's prices, calling providers only when needed. */
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

    const failures: string[] = [];
    for (const provider of this.providers) {
      // Pad each side so nearest-neighbor works at day boundaries even at
      // the provider's coarsest granularity.
      const pad = Math.max(provider.granularitySec * 2, 120);
      const from = dayStart - pad;
      const to = Math.min(dayEnd + pad, this.now());

      let points: Array<[number, number]>;
      try {
        points = await provider.fetchRange(from, to);
      } catch (error) {
        if (error instanceof ProviderUnavailableError) {
          failures.push(error.message);
          continue;
        }
        throw error;
      }
      if (points.length === 0 && dayStart < this.now()) {
        failures.push(`${provider.id}: returned no points`);
        continue;
      }

      const file: DayFile = {
        day,
        source: provider.id,
        points: points.filter(([ts]) => ts >= from && ts < dayEnd + pad),
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

    throw new SolPriceFeedError(
      `no provider could serve ${day}: ${failures.join(" | ")}`,
    );
  }
}

function dayOf(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}
