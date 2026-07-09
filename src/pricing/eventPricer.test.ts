import { describe, expect, it } from "vitest";
import { NATIVE_SOL_MINT } from "../classifier/programs.js";
import type { NormalizedEvent } from "../classifier/types.js";
import { EventPricer, USDC_MINT, type PricedEvent } from "./eventPricer.js";
import type { SolPriceFeed } from "./solPriceFeed.js";

const T = 1_750_000_000;
const MEME = "PumpFunMemeToken111111111111111111111111pump";
const OTHER = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

/** Feed stub: SOL = $200 flat, 10s distance; null when priceless=true. */
function makePricer(priceless = false): EventPricer {
  const feed = {
    getPriceAt: async () =>
      priceless ? null : { atTimestamp: T, price: 200, distanceSec: 10 },
  } as unknown as SolPriceFeed;
  return new EventPricer(feed);
}

let seq = 0;
function makeEvent(overrides: Partial<NormalizedEvent>): NormalizedEvent {
  seq += 1;
  return {
    signature: `sig-${seq}`,
    timestamp: T,
    type: "SWAP",
    protocol: "PUMPFUN",
    tokenInMint: null,
    amountIn: null,
    tokenOutMint: null,
    amountOut: null,
    feeLamports: 5000,
    ...overrides,
  };
}

function expectPriced(e: PricedEvent, usd: number, source: string): void {
  expect(e.needsPrice).toBe(false);
  expect(e.usdValue).toBeCloseTo(usd, 9);
  expect(e.priceSource).toBe(source);
}

describe("EventPricer", () => {
  it("prices a SOL -> token buy from the SOL leg", async () => {
    const e = await makePricer().priceEvent(makeEvent({
      tokenInMint: NATIVE_SOL_MINT, amountIn: 1.5,
      tokenOutMint: MEME, amountOut: 30_000_000,
    }));

    expectPriced(e, 300, "SOL_LEG"); // 1.5 SOL × $200
    expect(e.solUsd).toBe(200);
    expect(e.priceDistanceSec).toBe(10);
    expect(e.tokenInPriceUsd).toBeCloseTo(200, 9);
    expect(e.tokenOutPriceUsd).toBeCloseTo(300 / 30_000_000, 15); // derived memecoin price
    expect(e.feeUsd).toBeCloseTo(0.000005 * 200, 12);
  });

  it("prices a token -> SOL sell from the SOL leg", async () => {
    const e = await makePricer().priceEvent(makeEvent({
      tokenInMint: MEME, amountIn: 30_000_000,
      tokenOutMint: NATIVE_SOL_MINT, amountOut: 0.94,
    }));
    expectPriced(e, 188, "SOL_LEG");
    expect(e.tokenInPriceUsd).toBeCloseTo(188 / 30_000_000, 15);
  });

  it("prefers a stablecoin leg over the SOL leg", async () => {
    const e = await makePricer().priceEvent(makeEvent({
      tokenInMint: USDC_MINT, amountIn: 450,
      tokenOutMint: NATIVE_SOL_MINT, amountOut: 2.2,
    }));
    expectPriced(e, 450, "STABLE_LEG");
    // Implied SOL price from the trade itself, not the feed.
    expect(e.tokenOutPriceUsd).toBeCloseTo(450 / 2.2, 9);
  });

  it("flags token-to-token swaps with no anchor as NEEDS_PRICE", async () => {
    const e = await makePricer().priceEvent(makeEvent({
      tokenInMint: MEME, amountIn: 1000,
      tokenOutMint: OTHER, amountOut: 500,
    }));
    expect(e.needsPrice).toBe(true);
    expect(e.usdValue).toBeNull();
    expect(e.tokenInPriceUsd).toBeNull();
  });

  it("flags a SOL-leg swap as NEEDS_PRICE when the feed has no near point", async () => {
    const e = await makePricer(true).priceEvent(makeEvent({
      tokenInMint: NATIVE_SOL_MINT, amountIn: 1,
      tokenOutMint: MEME, amountOut: 100,
    }));
    expect(e.needsPrice).toBe(true);
    expect(e.feeUsd).toBeNull(); // no SOL price for the fee either
  });

  it("prices SOL transfers and income directly", async () => {
    const income = await makePricer().priceEvent(makeEvent({
      type: "INCOME", protocol: null,
      tokenOutMint: NATIVE_SOL_MINT, amountOut: 0.35,
    }));
    expectPriced(income, 70, "SOL_LEG");

    const out = await makePricer().priceEvent(makeEvent({
      type: "TRANSFER_OUT", protocol: null,
      tokenInMint: NATIVE_SOL_MINT, amountIn: 2,
    }));
    expectPriced(out, 400, "SOL_LEG");
  });

  it("flags transfers/income of unpriceable tokens", async () => {
    const e = await makePricer().priceEvent(makeEvent({
      type: "INCOME", protocol: null,
      tokenOutMint: MEME, amountOut: 500,
    }));
    expect(e.needsPrice).toBe(true);
  });

  it("prices only the fee for FEE_ONLY and FAILED, without flagging", async () => {
    for (const type of ["FEE_ONLY", "FAILED"] as const) {
      const e = await makePricer().priceEvent(makeEvent({ type, protocol: null }));
      expect(e.usdValue).toBeNull();
      expect(e.needsPrice).toBe(false);
      expect(e.feeUsd).toBeCloseTo(0.001, 9); // 5000 lamports × $200
    }
  });

  it("leaves SPAM unvalued and unflagged", async () => {
    const e = await makePricer().priceEvent(makeEvent({
      type: "SPAM", protocol: null, feeLamports: 0,
      tokenOutMint: MEME, amountOut: 88_888,
    }));
    expect(e.usdValue).toBeNull();
    expect(e.needsPrice).toBe(false);
    expect(e.feeUsd).toBeNull();
  });
});
