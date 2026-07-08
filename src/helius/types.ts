export interface NativeTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  /** Lamports. */
  amount: number;
}

export interface TokenTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  fromTokenAccount?: string;
  toTokenAccount?: string;
  mint: string;
  /** Decimal-adjusted amount, as Helius provides it. */
  tokenAmount: number;
  tokenStandard?: string;
}

export interface InnerInstruction {
  programId: string;
  accounts?: string[];
  data?: string;
}

export interface ParsedInstruction {
  programId: string;
  accounts?: string[];
  data?: string;
  innerInstructions?: InnerInstruction[];
}

/**
 * Subset of the Helius Enhanced Transactions API response that we rely on.
 * The full parsed transaction is preserved verbatim in the cache; these are
 * the fields the client and classifier actually read.
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
  nativeTransfers?: NativeTransfer[];
  tokenTransfers?: TokenTransfer[];
  instructions?: ParsedInstruction[];
  transactionError?: unknown;
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
