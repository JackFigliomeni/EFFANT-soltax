import { describe, expect, it } from "vitest";
import { NATIVE_SOL_MINT } from "../classifier/programs.js";
import type { PricedEvent } from "./eventPricer.js";
import { mergePortfolioEvents } from "./portfolio.js";

function ev(overrides: Partial<PricedEvent>): PricedEvent {
  return {
    signature: "sig-a",
    timestamp: 1_700_000_000,
    type: "SWAP",
    protocol: null,
    tokenInMint: null,
    amountIn: null,
    tokenOutMint: null,
    amountOut: null,
    feeLamports: 5000,
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

describe("mergePortfolioEvents", () => {
  it("keeps one event per signature across wallet perspectives", () => {
    // The same inter-wallet transfer, seen from the sender and the receiver.
    const fromSender = ev({
      signature: "shared-tx",
      type: "SELF_TRANSFER",
      tokenInMint: NATIVE_SOL_MINT,
      amountIn: 1,
    });
    const fromReceiver = ev({
      signature: "shared-tx",
      type: "SELF_TRANSFER",
      tokenOutMint: NATIVE_SOL_MINT,
      amountOut: 1,
    });

    const merged = mergePortfolioEvents([fromSender, fromReceiver]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.type).toBe("SELF_TRANSFER");
  });

  it("prefers the most informative classification for a shared signature", () => {
    // One wallet swapped; the other wallet only saw incidental movement.
    const asFeeOnly = ev({ signature: "shared-tx", type: "FEE_ONLY" });
    const asSwap = ev({
      signature: "shared-tx",
      type: "SWAP",
      tokenInMint: NATIVE_SOL_MINT,
      amountIn: 1,
      tokenOutMint: "Meme111111111111111111111111111111111111111",
      amountOut: 1000,
      usdValue: 150,
    });

    const merged = mergePortfolioEvents([asFeeOnly, asSwap]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.type).toBe("SWAP");
  });

  it("sorts the merged stream chronologically", () => {
    const later = ev({ signature: "b", timestamp: 2_000 });
    const earlier = ev({ signature: "a", timestamp: 1_000 });
    const merged = mergePortfolioEvents([later, earlier]);
    expect(merged.map((e) => e.signature)).toEqual(["a", "b"]);
  });

  it("leaves distinct signatures untouched", () => {
    const events = [ev({ signature: "a" }), ev({ signature: "b", timestamp: 1_700_000_001 })];
    expect(mergePortfolioEvents(events)).toHaveLength(2);
  });
});
