import { TransactionCache } from "./transactionCache.js";
import type {
  FetchHistoryOptions,
  FetchHistoryResult,
  FetchProgress,
  HeliusParsedTransaction,
} from "./types.js";

export interface HeliusClientOptions {
  apiKey: string;
  cacheDir: string;
  baseUrl?: string;
  /** Transactions per page; Helius caps this at 100. */
  pageSize?: number;
  maxRetries?: number;
  /** Initial backoff delay in ms; doubles per retry. */
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
}

export class HeliusRateLimitError extends Error {
  constructor(retries: number) {
    super(`Helius API still rate-limiting after ${retries} retries; giving up`);
    this.name = "HeliusRateLimitError";
  }
}

export class HeliusApiError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`Helius API request failed with status ${status}: ${body.slice(0, 300)}`);
    this.name = "HeliusApiError";
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Client for the Helius Enhanced Transactions API
 * (GET /v0/addresses/{address}/transactions).
 *
 * fetchHistory pulls the wallet's complete parsed transaction history:
 *  - pages newest-to-oldest using the `before` signature cursor
 *  - retries 429/5xx responses with exponential backoff + jitter,
 *    honoring Retry-After when present
 *  - appends each page straight to a per-wallet JSONL cache, so memory
 *    stays flat regardless of history size
 *  - keys the cache by signature and persists the pagination cursor after
 *    every page, so interrupted or repeated runs never refetch a
 *    transaction that is already on disk
 */
export class HeliusClient {
  private readonly apiKey: string;
  private readonly cacheDir: string;
  private readonly baseUrl: string;
  private readonly pageSize: number;
  private readonly maxRetries: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: HeliusClientOptions) {
    this.apiKey = options.apiKey;
    this.cacheDir = options.cacheDir;
    this.baseUrl = options.baseUrl ?? "https://api.helius.xyz";
    this.pageSize = options.pageSize ?? 100;
    this.maxRetries = options.maxRetries ?? 8;
    this.initialBackoffMs = options.initialBackoffMs ?? 500;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleep = options.sleepFn ?? defaultSleep;
  }

  async fetchHistory(
    wallet: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const cache = await TransactionCache.open(this.cacheDir, wallet);
    const progress: FetchProgress = { fetched: 0, cached: 0, pages: 0 };

    try {
      const meta = cache.getMeta();

      // Phase A: fetch from the head of history until we hit a signature we
      // already have. All cached ranges are contiguous from some previous
      // head, so the first cached signature marks known territory.
      const hitCached = await this.paginate(wallet, cache, progress, {
        before: undefined,
        stopOnCached: true,
        untilTimestamp: options.untilTimestamp,
        onProgress: options.onProgress,
      });

      // Phase B: if a previous run never reached the end of history, resume
      // backfilling from the stored oldest-signature cursor.
      if (!cache.getMeta().complete && (hitCached || meta.oldestSignature !== undefined)) {
        await this.paginate(wallet, cache, progress, {
          before: cache.getMeta().oldestSignature,
          stopOnCached: false,
          untilTimestamp: options.untilTimestamp,
          onProgress: options.onProgress,
        });
      }

      return {
        total: cache.size,
        fetched: progress.fetched,
        cached: progress.cached,
        cacheFile: cache.jsonlPath,
      };
    } finally {
      await cache.close();
    }
  }

  /** Streams every cached transaction for a wallet (after fetchHistory). */
  async *readHistory(wallet: string): AsyncGenerator<HeliusParsedTransaction> {
    const cache = await TransactionCache.open(this.cacheDir, wallet);
    try {
      yield* cache.readAll();
    } finally {
      await cache.close();
    }
  }

  /**
   * Pages from `before` toward older history, appending uncached
   * transactions. Returns true if it stopped because it reached a cached
   * signature (rather than the end of history).
   */
  private async paginate(
    wallet: string,
    cache: TransactionCache,
    progress: FetchProgress,
    opts: {
      before: string | undefined;
      stopOnCached: boolean;
      untilTimestamp?: number | undefined;
      onProgress?: ((p: FetchProgress) => void) | undefined;
    },
  ): Promise<boolean> {
    let before = opts.before;
    let isFirstPage = opts.before === undefined;

    for (;;) {
      const page = await this.fetchPage(wallet, before);
      progress.pages += 1;

      if (page.length === 0) {
        await cache.updateMeta({ complete: true });
        opts.onProgress?.({ ...progress });
        return false;
      }

      const newestInPage = page[0];
      if (isFirstPage && newestInPage && !cache.has(newestInPage.signature)) {
        await cache.updateMeta({ newestSignature: newestInPage.signature });
      }
      isFirstPage = false;

      for (const tx of page) {
        if (cache.has(tx.signature)) {
          if (opts.stopOnCached) {
            await cache.updateMeta({});
            opts.onProgress?.({ ...progress });
            return true;
          }
          progress.cached += 1;
          continue;
        }
        await cache.append(tx);
        progress.fetched += 1;

        if (opts.untilTimestamp !== undefined && tx.timestamp < opts.untilTimestamp) {
          await cache.updateMeta({ oldestSignature: tx.signature });
          opts.onProgress?.({ ...progress });
          return false;
        }
      }

      const oldestInPage = page[page.length - 1];
      if (oldestInPage === undefined) return false; // unreachable: page is non-empty
      before = oldestInPage.signature;
      await cache.updateMeta({ oldestSignature: before });
      opts.onProgress?.({ ...progress });
    }
  }

  private async fetchPage(
    wallet: string,
    before: string | undefined,
  ): Promise<HeliusParsedTransaction[]> {
    const url = new URL(`/v0/addresses/${wallet}/transactions`, this.baseUrl);
    url.searchParams.set("api-key", this.apiKey);
    url.searchParams.set("limit", String(this.pageSize));
    if (before !== undefined) {
      url.searchParams.set("before", before);
    }

    let backoff = this.initialBackoffMs;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const response = await this.fetchFn(url);

      if (response.status === 429 || response.status >= 500) {
        if (attempt === this.maxRetries) {
          if (response.status === 429) throw new HeliusRateLimitError(this.maxRetries);
          throw new HeliusApiError(response.status, await response.text());
        }
        const retryAfter = response.headers.get("retry-after");
        const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : NaN;
        const jitter = Math.random() * backoff * 0.25;
        const delay = Number.isFinite(retryAfterMs)
          ? retryAfterMs
          : Math.min(backoff, this.maxBackoffMs) + jitter;
        await this.sleep(delay);
        backoff = Math.min(backoff * 2, this.maxBackoffMs);
        continue;
      }

      if (!response.ok) {
        throw new HeliusApiError(response.status, await response.text());
      }

      return (await response.json()) as HeliusParsedTransaction[];
    }

    throw new HeliusRateLimitError(this.maxRetries);
  }
}
