import { describe, expect, it } from "vitest";
import { NATIVE_SOL_MINT } from "../classifier/programs.js";
import type { PricedEvent } from "../pricing/eventPricer.js";
import { auditFifoResult } from "./audit.js";
import { FifoEngine } from "./fifoEngine.js";
import { buildReports, csvField } from "./reports.js";

const SOL = NATIVE_SOL_MINT;
const MEME = "Meme111111111111111111111111111111111111111";
// 2023-06-15T00:00:00Z and one year+ later in 2024.
const T2023 = Date.parse("2023-06-15T00:00:00Z") / 1000;
const T2024 = Date.parse("2024-08-15T00:00:00Z") / 1000;

let seq = 0;
function ev(overrides: Partial<PricedEvent>): PricedEvent {
  seq += 1;
  return {
    signature: `sig-${String(seq).padStart(3, "0")}`,
    timestamp: T2023 + seq * 60,
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

/** Deposit $1000 (2023) → buy MEME $600 (2023) → sell MEME $900 (2024, long-term). */
function scenario(): PricedEvent[] {
  return [
    ev({ type: "TRANSFER_IN", tokenOutMint: SOL, amountOut: 10, usdValue: 1000, timestamp: T2023 }),
    ev({
      type: "SWAP", tokenInMint: SOL, amountIn: 5, tokenOutMint: MEME,
      amountOut: 1000, usdValue: 600, timestamp: T2023 + 3600,
    }),
    ev({
      type: "SWAP", tokenInMint: MEME, amountIn: 1000, tokenOutMint: SOL,
      amountOut: 6, usdValue: 900, timestamp: T2024,
    }),
    ev({ type: "SPAM", tokenOutMint: "Spam1111111111111111111111111111111111111111", amountOut: 5, timestamp: T2024 + 60 }),
  ];
}

function run(events: PricedEvent[], year?: number) {
  const result = new FifoEngine().process(events);
  const audit = auditFifoResult(events, result);
  return buildReports(events, result, {
    wallet: "TestWa11et1111111111111111111111111111111111",
    ...(year !== undefined && { year }),
    audit,
  });
}

describe("buildReports", () => {
  it("splits 8949 into short and long term sections with totals", () => {
    const bundle = run(scenario());
    const short = bundle.files.get("all-years-8949-short-term.csv")!;
    const long = bundle.files.get("all-years-8949-long-term.csv")!;

    // Short-term: the SOL disposal (held < 1h). basis 500, proceeds 600, gain 100.
    expect(short).toContain("5 SOL");
    expect(short).toContain("06/15/2023,600.00,500.00,100.00");
    expect(short).toContain("TOTAL,,,600.00,500.00,100.00");

    // Long-term: MEME held 2023-06 -> 2024-08. basis 600, proceeds 900, gain 300.
    expect(long).toContain("1000 Meme11");
    expect(long).toContain("08/15/2024,900.00,600.00,300.00");
    expect(long).toContain("TOTAL,,,900.00,600.00,300.00");
  });

  it("produces TurboTax rows for every resolved disposal", () => {
    const bundle = run(scenario());
    const tt = bundle.files.get("all-years-turbotax.csv")!.trim().split("\n");
    expect(tt[0]).toBe("Currency Name,Purchase Date,Cost Basis,Date Sold,Proceeds");
    expect(tt).toHaveLength(3); // header + SOL + MEME disposals
    expect(tt[2]).toBe("1000 Meme11…1111,06/15/2023,600.00,08/15/2024,900.00");
  });

  it("includes every event, spam included, in the ledger", () => {
    const bundle = run(scenario());
    const ledger = bundle.files.get("all-years-ledger.csv")!;
    const rows = ledger.trim().split("\n");
    expect(rows).toHaveLength(5); // header + 4 events
    expect(ledger).toContain("SPAM");
    expect(ledger).toContain("https://solscan.io/tx/");
  });

  it("filters by tax year", () => {
    const bundle = run(scenario(), 2024);
    const short = bundle.files.get("2024-8949-short-term.csv")!;
    const long = bundle.files.get("2024-8949-long-term.csv")!;

    // Only the 2024 MEME disposal is in-year; the 2023 SOL disposal is not.
    expect(short).not.toContain("5 SOL");
    expect(long).toContain("900.00");
    expect(bundle.summaryText).toContain("Tax year: 2024");
    expect(bundle.summaryText).toContain("Net long-term gain/loss:   $300.00  (1 disposals)");
    expect(bundle.summaryText).toContain("Net short-term gain/loss:  $0.00  (0 disposals)");
  });

  it("routes unresolved disposals to needs-review, never to the 8949", () => {
    const events = [
      ...scenario(),
      // Disposal with no known lots: MISSING_HISTORY.
      ev({
        type: "SWAP", tokenInMint: "Ghost111111111111111111111111111111111111111",
        amountIn: 50, tokenOutMint: SOL, amountOut: 1, usdValue: 150, timestamp: T2024 + 120,
      }),
    ];
    const bundle = run(events);

    const review = bundle.files.get("all-years-needs-review.csv")!;
    expect(review).toContain("UNRESOLVED_DISPOSAL");
    expect(review).toContain("MISSING_HISTORY");

    const short = bundle.files.get("all-years-8949-short-term.csv")!;
    expect(short).not.toContain("Ghost1");
    expect(bundle.summaryText).toContain("unresolved disposals -> needs-review.csv");
  });

  it("escapes CSV fields containing commas, quotes, and newlines", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField(1234.5)).toBe("1234.5");
    expect(csvField(null)).toBe("");
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("line1\nline2")).toBe('"line1\nline2"');
  });

  it("summary carries the audit verdict and key figures", () => {
    const bundle = run(scenario());
    expect(bundle.summaryText).toContain("MATH AUDIT: PASS");
    expect(bundle.summaryText).toContain("Net short-term gain/loss:  $100.00");
    expect(bundle.summaryText).toContain("Net long-term gain/loss:   $300.00");
    expect(bundle.summaryText).toContain("not tax advice");
  });
});
