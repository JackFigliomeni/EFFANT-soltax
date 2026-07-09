import { describe, expect, it } from "vitest";
import { NATIVE_SOL_MINT } from "../classifier/programs.js";
import type { PricedEvent } from "../pricing/eventPricer.js";
import { FifoEngine } from "./fifoEngine.js";

const SOL = NATIVE_SOL_MINT;
const MEME = "PumpFunMemeToken111111111111111111111111pump";
const T0 = 1_700_000_000;
const DAY = 86_400;

let seq = 0;
function ev(overrides: Partial<PricedEvent>): PricedEvent {
  seq += 1;
  return {
    signature: `sig-${String(seq).padStart(3, "0")}`,
    timestamp: T0 + seq * 60,
    type: "SWAP",
    protocol: null,
    tokenInMint: null,
    amountIn: null,
    tokenOutMint: null,
    amountOut: null,
    feeLamports: 0,
    usdValue: null,
    priceSource: null,
    solUsd: null,
    priceDistanceSec: null,
    tokenInPriceUsd: null,
    tokenOutPriceUsd: null,
    feeUsd: null,
    needsPrice: false,
    ...overrides,
  };
}

function deposit(mint: string, amount: number, usdValue: number, at = T0): PricedEvent {
  return ev({ type: "TRANSFER_IN", tokenOutMint: mint, amountOut: amount, usdValue, timestamp: at });
}

function swap(
  inMint: string, amountIn: number,
  outMint: string, amountOut: number,
  usdValue: number | null, at: number, feeUsd = 0,
): PricedEvent {
  return ev({
    type: "SWAP", tokenInMint: inMint, amountIn, tokenOutMint: outMint, amountOut,
    usdValue, timestamp: at, feeUsd, needsPrice: usdValue === null,
  });
}

describe("FifoEngine", () => {
  it("computes gain on a simple buy -> sell round trip", () => {
    // Deposit 10 SOL worth $1000, buy MEME for 5 SOL ($600), sell for 5.5 SOL ($900).
    const result = new FifoEngine().process([
      deposit(SOL, 10, 1000, T0),
      swap(SOL, 5, MEME, 1_000_000, 600, T0 + DAY),
      swap(MEME, 1_000_000, SOL, 5.5, 900, T0 + 2 * DAY),
    ]);

    // Disposal 1: 5 SOL, basis $500 (half the deposit), proceeds $600 → +100.
    // Disposal 2: MEME, basis $600, proceeds $900 → +300.
    expect(result.disposals).toHaveLength(2);
    expect(result.disposals[0]).toMatchObject({
      asset: SOL, amount: 5, costBasisUsd: 500, proceedsUsd: 600, gainLossUsd: 100, term: "SHORT",
    });
    expect(result.disposals[1]).toMatchObject({
      asset: MEME, costBasisUsd: 600, proceedsUsd: 900, gainLossUsd: 300, term: "SHORT",
    });
    expect(result.totals.shortTermGainUsd).toBeCloseTo(400, 9);
    expect(result.totals.longTermGainUsd).toBe(0);

    // Open lots: 5 SOL from the deposit ($500) + 5.5 SOL from the sell ($900).
    const solLots = result.openLots.filter((l) => l.asset === SOL);
    expect(solLots).toHaveLength(2);
    expect(solLots[0]!.amount).toBeCloseTo(5, 9);
    expect(solLots[0]!.costBasisUsd).toBeCloseTo(500, 9);
    expect(solLots[1]!.costBasisUsd).toBeCloseTo(900, 9);
  });

  it("consumes lots FIFO across different bases", () => {
    // Two MEME buys: 100 @ $1/unit, then 100 @ $2/unit. Sell 150 @ $3/unit.
    const result = new FifoEngine().process([
      deposit(SOL, 100, 10_000, T0),
      swap(SOL, 1, MEME, 100, 100, T0 + 60),
      swap(SOL, 2, MEME, 100, 200, T0 + 120),
      swap(MEME, 150, SOL, 4.5, 450, T0 + 180),
    ]);

    const memeDisposals = result.disposals.filter((d) => d.asset === MEME);
    expect(memeDisposals).toHaveLength(2);
    // 100 units from lot 1: basis $100, proceeds $300 → +200.
    expect(memeDisposals[0]).toMatchObject({ amount: 100, costBasisUsd: 100, gainLossUsd: 200 });
    // 50 units from lot 2: basis $100, proceeds $150 → +50.
    expect(memeDisposals[1]!.amount).toBeCloseTo(50, 9);
    expect(memeDisposals[1]!.costBasisUsd).toBeCloseTo(100, 9);
    expect(memeDisposals[1]!.gainLossUsd).toBeCloseTo(50, 9);
  });

  it("classifies holdings over a year as long-term", () => {
    const result = new FifoEngine().process([
      deposit(SOL, 10, 1000, T0),
      swap(SOL, 10, MEME, 100, 1000, T0 + 60),
      swap(MEME, 100, SOL, 20, 4000, T0 + 60 + 366 * DAY),
    ]);

    const memeDisposal = result.disposals.find((d) => d.asset === MEME)!;
    expect(memeDisposal.term).toBe("LONG");
    expect(memeDisposal.gainLossUsd).toBeCloseTo(3000, 9);
    expect(result.totals.longTermGainUsd).toBeCloseTo(3000, 9);
    // The SOL disposal at T0+60 is short-term.
    expect(result.totals.shortTermGainUsd).toBeCloseTo(0, 9);
  });

  it("records income at FMV and uses it as basis on disposal", () => {
    const result = new FifoEngine().process([
      ev({ type: "INCOME", tokenOutMint: SOL, amountOut: 2, usdValue: 300, timestamp: T0 }),
      swap(SOL, 2, MEME, 100, 500, T0 + DAY),
    ]);

    expect(result.income).toHaveLength(1);
    expect(result.totals.ordinaryIncomeUsd).toBe(300);
    // Disposing the income SOL: proceeds $500 - FMV basis $300 = +200.
    expect(result.disposals[0]).toMatchObject({ asset: SOL, costBasisUsd: 300, gainLossUsd: 200 });
  });

  it("keeps lots intact through SELF_TRANSFER", () => {
    const result = new FifoEngine().process([
      deposit(SOL, 10, 1000, T0),
      ev({ type: "SELF_TRANSFER", tokenInMint: SOL, amountIn: 10, timestamp: T0 + 60 }),
      swap(SOL, 10, MEME, 100, 2000, T0 + 120),
    ]);

    // No disposal from the self-transfer; the swap still finds the full lot.
    expect(result.disposals).toHaveLength(1);
    expect(result.disposals[0]).toMatchObject({ asset: SOL, costBasisUsd: 1000, gainLossUsd: 1000 });
    expect(result.flags.filter((f) => f.kind === "MISSING_HISTORY")).toHaveLength(0);
  });

  it("flags MISSING_HISTORY loudly instead of inventing basis", () => {
    const result = new FifoEngine().process([
      deposit(SOL, 2, 200, T0),
      // Sells 5 SOL but only 2 are known.
      swap(SOL, 5, MEME, 100, 1000, T0 + 60),
    ]);

    const solDisposals = result.disposals.filter((d) => d.asset === SOL);
    expect(solDisposals).toHaveLength(2);
    // Covered part: 2 SOL, basis $200, proceeds 2/5 × $1000 = $400 → +200.
    expect(solDisposals[0]).toMatchObject({ amount: 2, costBasisUsd: 200, gainLossUsd: 200 });
    // Uncovered part: 3 SOL, no basis, no gain — flagged.
    expect(solDisposals[1]).toMatchObject({
      amount: 3, acquiredAt: null, costBasisUsd: null, gainLossUsd: null,
    });
    expect(solDisposals[1]!.flags).toContain("MISSING_HISTORY");
    expect(result.flags.some((f) => f.kind === "MISSING_HISTORY")).toBe(true);
    expect(result.totals.unresolvedDisposals).toBe(1);
  });

  it("propagates NEEDS_PRICE through disposals and acquisitions", () => {
    const OTHER = "OtherToken1111111111111111111111111111111111";
    const result = new FifoEngine().process([
      deposit(SOL, 10, 1000, T0),
      swap(SOL, 5, MEME, 100, 500, T0 + 60),
      // Token-to-token with no anchor: unpriced.
      swap(MEME, 100, OTHER, 50, null, T0 + 120),
      // Selling OTHER later: proceeds known, basis unknown.
      swap(OTHER, 50, SOL, 1, 300, T0 + 180),
    ]);

    const memeDisposal = result.disposals.find((d) => d.asset === MEME)!;
    expect(memeDisposal.proceedsUsd).toBeNull();
    expect(memeDisposal.gainLossUsd).toBeNull();
    expect(memeDisposal.flags).toContain("NEEDS_PRICE");

    const otherDisposal = result.disposals.find((d) => d.asset === OTHER)!;
    expect(otherDisposal.proceedsUsd).toBeCloseTo(300, 9);
    expect(otherDisposal.costBasisUsd).toBeNull();
    expect(otherDisposal.gainLossUsd).toBeNull();

    expect(result.totals.unresolvedDisposals).toBe(2);
  });

  it("adds the network fee to the acquired lot's basis", () => {
    const result = new FifoEngine().process([
      deposit(SOL, 10, 1000, T0),
      swap(SOL, 5, MEME, 100, 500, T0 + 60, 2), // $2 fee
      swap(MEME, 100, SOL, 6, 800, T0 + 120),
    ]);

    const memeDisposal = result.disposals.find((d) => d.asset === MEME)!;
    expect(memeDisposal.costBasisUsd).toBeCloseTo(502, 9);
    expect(memeDisposal.gainLossUsd).toBeCloseTo(298, 9);
  });

  it("removes withdrawn lots without realizing gain, flagged for review", () => {
    const result = new FifoEngine().process([
      deposit(SOL, 10, 1000, T0),
      swap(SOL, 5, MEME, 100, 600, T0 + 60),
      ev({ type: "TRANSFER_OUT", tokenInMint: MEME, amountIn: 100, timestamp: T0 + 120 }),
    ]);

    // Only the SOL swap disposal exists — the withdrawal realized nothing.
    expect(result.disposals.filter((d) => d.asset === MEME)).toHaveLength(0);
    expect(result.openLots.filter((l) => l.asset === MEME)).toHaveLength(0);
    expect(result.flags.some((f) => f.kind === "REVIEW_WITHDRAWAL")).toBe(true);
  });

  it("flags deposits for basis review", () => {
    const result = new FifoEngine().process([deposit(SOL, 10, 1000, T0)]);
    expect(result.flags.some((f) => f.kind === "REVIEW_DEPOSIT")).toBe(true);
    expect(result.openLots[0]).toMatchObject({ asset: SOL, costBasisUsd: 1000, source: "DEPOSIT" });
  });
});
