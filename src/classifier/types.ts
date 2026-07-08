export type EventType =
  | "TRANSFER_IN"
  | "TRANSFER_OUT"
  | "SELF_TRANSFER"
  | "SWAP"
  | "INCOME"
  | "FEE_ONLY"
  | "SPAM"
  | "FAILED"
  | "UNKNOWN";

/**
 * Protocols detected by program ID. Swaps can also carry other protocol
 * strings (e.g. "DFLOW", "OKX") taken from Helius' own source tag when the
 * program is not one we match ourselves.
 */
export type KnownProtocol =
  | "JUPITER"
  | "OKX"
  | "DFLOW"
  | "MOONSHOT"
  | "PUMPFUN"
  | "PUMPSWAP"
  | "RAYDIUM_AMM"
  | "RAYDIUM_CLMM";

/**
 * One user-level event derived from a parsed transaction.
 *
 * Direction follows DEX convention from the user's perspective:
 *   tokenInMint/amountIn   — what the user GAVE (went into the trade/transfer)
 *   tokenOutMint/amountOut — what the user GOT (came out to the wallet)
 *
 * Native SOL uses NATIVE_SOL_MINT as its mint. Amounts are decimal-adjusted
 * (SOL for native, token units for SPL); fees stay in lamports as named.
 */
export interface NormalizedEvent {
  signature: string;
  timestamp: number;
  type: EventType;
  protocol: string | null;
  tokenInMint: string | null;
  amountIn: number | null;
  tokenOutMint: string | null;
  amountOut: number | null;
  feeLamports: number;
}

export interface ClassifierContext {
  /** The wallet whose perspective events are normalized to. */
  wallet: string;
  /**
   * Other wallets the user owns. Transfers between owned wallets become
   * SELF_TRANSFER (non-taxable movement) instead of deposits/withdrawals.
   */
  ownedWallets?: string[];
  /** Incoming native transfers at or below this are dust attacks (default 100_000). */
  dustThresholdLamports?: number;
}

export interface ClassifyAllOptions extends ClassifierContext {
  /** Keep SPAM and FAILED events in the output (default: excluded). */
  includeSpam?: boolean;
}
