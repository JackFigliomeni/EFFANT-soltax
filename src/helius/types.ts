/**
 * Subset of the Helius Enhanced Transactions API response that we rely on.
 * The full parsed transaction is preserved verbatim in the cache; these are
 * just the fields the client itself needs to paginate and key the cache.
 */
export interface HeliusParsedTransaction {
  signature: string;
  timestamp: number;
  slot: number;
  type: string;
  source: string;
  fee: number;
  feePayer: string;
  description: string;
  [key: string]: unknown;
}

export interface FetchHistoryOptions {
  /** Stop paginating once a transaction older than this unix time is seen. */
  untilTimestamp?: number;
  /** Called after each page is persisted, for progress reporting. */
  onProgress?: (progress: FetchProgress) => void;
}

export interface FetchProgress {
  /** Transactions fetched from the API during this run. */
  fetched: number;
  /** Transactions skipped because they were already cached. */
  cached: number;
  /** Total pages requested so far during this run. */
  pages: number;
}

export interface FetchHistoryResult {
  /** Total transactions now in the cache for this wallet. */
  total: number;
  /** How many were newly fetched (vs already cached) in this run. */
  fetched: number;
  cached: number;
  /** Path to the JSONL cache file holding the full history. */
  cacheFile: string;
}
