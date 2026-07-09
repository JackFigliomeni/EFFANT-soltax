import { LAMPORTS_PER_SOL, NATIVE_SOL_MINT } from "../classifier/programs.js";
import type { NormalizedEvent } from "../classifier/types.js";
import type { SolPriceFeed } from "./solPriceFeed.js";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
/** USD stablecoins valued 1:1 — the strongest possible price anchor. */
const STABLE_MINTS: ReadonlySet<string> = new Set([USDC_MINT, USDT_MINT]);

export type PriceSource = "STABLE_LEG" | "SOL_LEG";

/**
 * A normalized event with USD values attached.
 *
 * Anchor hierarchy (most reliable first):
 *   1. STABLE_LEG — one leg is USDC/USDT: its amount IS the USD value.
 *   2. SOL_LEG    — one leg is SOL: amount × SOL/USD at the event's minute.
 *   3. neither    — needsPrice=true; we never guess.
 *
 * tokenIn/OutPriceUsd are per-unit prices implied by the executed trade —
 * this is how illiquid memecoins with no price feed get a defensible price.
 */
export interface PricedEvent extends NormalizedEvent {
  /** USD value of the trade/movement at execution time. */
  usdValue: number | null;
  priceSource: PriceSource | null;
  /** SOL/USD used (when a SOL leg or fee was priced). */
  solUsd: number | null;
  /** Seconds between the event and the SOL/USD candle used. */
  priceDistanceSec: number | null;
  /** Per-unit USD price of each leg, derived from the trade itself. */
  tokenInPriceUsd: number | null;
  tokenOutPriceUsd: number | null;
  feeUsd: number | null;
  /** True when a tax-relevant value exists but could not be priced. */
  needsPrice: boolean;
}

/** Event types that carry a tax-relevant value to price. */
const VALUED_TYPES: ReadonlySet<string> = new Set([
  "SWAP",
  "TRANSFER_IN",
  "TRANSFER_OUT",
  "SELF_TRANSFER",
  "INCOME",
]);

export class EventPricer {
  constructor(private readonly feed: SolPriceFeed) {}

  async priceEvent(event: NormalizedEvent): Promise<PricedEvent> {
    const priced: PricedEvent = {
      ...event,
      usdValue: null,
      priceSource: null,
      solUsd: null,
      priceDistanceSec: null,
      tokenInPriceUsd: null,
      tokenOutPriceUsd: null,
      feeUsd: null,
      needsPrice: false,
    };

    // SOL/USD at the event's minute — anchors SOL legs and prices the fee.
    const sol = await this.feed.getPriceAt(event.timestamp);
    if (sol !== null) {
      priced.solUsd = sol.price;
      priced.priceDistanceSec = sol.distanceSec;
      if (event.feeLamports > 0) {
        priced.feeUsd = (event.feeLamports / LAMPORTS_PER_SOL) * sol.price;
      }
    }

    if (!VALUED_TYPES.has(event.type)) return priced;

    const legs = [
      { mint: event.tokenInMint, amount: event.amountIn },
      { mint: event.tokenOutMint, amount: event.amountOut },
    ].filter((l): l is { mint: string; amount: number } => l.mint !== null && l.amount !== null);
    if (legs.length === 0) return priced;

    const stableLeg = legs.find((l) => STABLE_MINTS.has(l.mint));
    const solLeg = legs.find((l) => l.mint === NATIVE_SOL_MINT);

    if (stableLeg) {
      priced.usdValue = stableLeg.amount;
      priced.priceSource = "STABLE_LEG";
    } else if (solLeg && sol !== null) {
      priced.usdValue = solLeg.amount * sol.price;
      priced.priceSource = "SOL_LEG";
    } else {
      // A value exists but no leg is priceable (token-to-token with no
      // SOL/stable side, or the price feed had no point close enough).
      priced.needsPrice = true;
      return priced;
    }

    if (event.tokenInMint !== null && event.amountIn !== null && event.amountIn > 0) {
      priced.tokenInPriceUsd = priced.usdValue / event.amountIn;
    }
    if (event.tokenOutMint !== null && event.amountOut !== null && event.amountOut > 0) {
      priced.tokenOutPriceUsd = priced.usdValue / event.amountOut;
    }

    return priced;
  }

  /** Streaming variant for cache-backed iteration over large wallets. */
  async *priceEvents(events: AsyncIterable<NormalizedEvent>): AsyncGenerator<PricedEvent> {
    for await (const event of events) {
      yield await this.priceEvent(event);
    }
  }
}
