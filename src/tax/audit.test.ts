import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NATIVE_SOL_MINT } from "../classifier/programs.js";
import { EventPricer } from "../pricing/eventPricer.js";
import type { PricedEvent } from "../pricing/eventPricer.js";
import type { NormalizedEvent } from "../classifier/types.js";
import type { SolPriceFeed } from "../pricing/solPriceFeed.js";
import { auditFifoResult } from "./audit.js";
import { FifoEngine } from "./fifoEngine.js";

const SOL = NATIVE_SOL_MINT;
const T0 = 1_700_000_000;

let seq = 0;
function ev(overrides: Partial<PricedEvent>): PricedEvent {
  seq += 1;
  return {
    signature: `sig-${String(seq).padStart(4, "0")}`,
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

const deposit = (amount: number, usd: number, at: number): PricedEvent =>
  ev({ type: "TRANSFER_IN", tokenOutMint: SOL, amountOut: amount, usdValue: usd, timestamp: at });

const swap = (
  inMint: string, amountIn: number, outMint: string, amountOut: number,
  usd: number, at: number, feeUsd = 0,
): PricedEvent =>
  ev({
    type: "SWAP", tokenInMint: inMint, amountIn, tokenOutMint: outMint,
    amountOut, usdValue: usd, timestamp: at, feeUsd,
  });

describe("auditFifoResult", () => {
  it("verifies the fully-closed wallet invariant: gains = net out - net in", () => {
    const MEME = "Meme111111111111111111111111111111111111111";
    // In: $1000 of SOL. Round-trip a memecoin. End: all MEME closed, only SOL open.
    const events = [
      deposit(10, 1000, T0),
      swap(SOL, 4, MEME, 1000, 500, T0 + 3600),        // SOL up: $500 for 4 SOL (basis 400) → +100
      swap(MEME, 1000, SOL, 6, 900, T0 + 7200),        // MEME: 900 - 500 → +400
    ];
    const result = new FifoEngine().process(events);

    // Hand math: gains = 100 + 400 = 500.
    // Open SOL basis = (6 SOL deposit lot @ $600) + (6 SOL from sell @ $900) = $1500.
    // Invariant: gains = openBasis - deposits = 1500 - 1000 = 500. ✓
    expect(result.totals.shortTermGainUsd).toBeCloseTo(500, 9);

    const report = auditFifoResult(events, result);
    expect(report.checks.map((c) => [c.name, c.ok, c.skipped])).toEqual([
      ["disposal arithmetic", true, false],
      ["amount conservation", true, false],
      ["USD conservation", true, false],
    ]);
    expect(report.ok).toBe(true);
  });

  it("detects deliberate corruption that per-row checks miss", () => {
    const MEME = "Meme111111111111111111111111111111111111111";
    const events = [
      deposit(10, 1000, T0),
      swap(SOL, 4, MEME, 1000, 500, T0 + 3600),
      swap(MEME, 1000, SOL, 6, 900, T0 + 7200),
    ];
    const result = new FifoEngine().process(events);

    // Corrupt a disposal the way a silent engine bug would: shift basis and
    // gain together so the row itself still satisfies gain = proceeds - basis.
    const target = result.disposals[1]!;
    target.costBasisUsd = target.costBasisUsd! - 50;
    target.gainLossUsd = target.gainLossUsd! + 50;
    result.totals.shortTermGainUsd += 50;

    const report = auditFifoResult(events, result);
    const conservation = report.checks.find((c) => c.name === "USD conservation")!;
    expect(conservation.ok).toBe(false);
    expect(conservation.detail).toContain("MISMATCH");
    expect(report.ok).toBe(false);
  });

  it("skips USD conservation (without failing) when values are unresolved", () => {
    const MYSTERY = "Mystery1111111111111111111111111111111111111";
    const events = [
      deposit(10, 1000, T0),
      // Unpriced token-to-token leaves nulls behind.
      swap(SOL, 2, MYSTERY, 100, 200, T0 + 3600),
      ev({
        type: "SWAP", tokenInMint: MYSTERY, amountIn: 100,
        tokenOutMint: "Other111111111111111111111111111111111111111", amountOut: 5,
        usdValue: null, needsPrice: true, timestamp: T0 + 7200,
      }),
    ];
    const result = new FifoEngine().process(events);
    const report = auditFifoResult(events, result);

    const conservation = report.checks.find((c) => c.name === "USD conservation")!;
    expect(conservation.skipped).toBe(true);
    expect(report.ok).toBe(true); // skipped ≠ failed
  });

  it("holds under a seeded fuzz of random priced wallets", () => {
    // Deterministic LCG so failures are reproducible.
    let state = 42;
    const rand = (): number => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state / 2_147_483_648;
    };

    for (let run = 0; run < 40; run++) {
      const tokens = ["TokA", "TokB", "TokC"].map((t) => `${t}${run}`.padEnd(43, "1"));
      const held = new Map<string, number>([[SOL, 0]]);
      const events: PricedEvent[] = [];
      let t = T0 + run;
      let solPrice = 50 + rand() * 250;

      const depositAmt = 10 + rand() * 90;
      events.push(deposit(depositAmt, depositAmt * solPrice, t));
      held.set(SOL, depositAmt);

      const ops = 10 + Math.floor(rand() * 30);
      for (let i = 0; i < ops; i++) {
        t += 60 + Math.floor(rand() * 86_400);
        solPrice *= 0.9 + rand() * 0.2;
        const token = tokens[Math.floor(rand() * tokens.length)]!;
        const tokenHeld = held.get(token) ?? 0;

        if (rand() < 0.5 && (held.get(SOL) ?? 0) > 1) {
          // Buy token with a random slice of SOL.
          const solIn = (held.get(SOL) ?? 0) * (0.1 + rand() * 0.4);
          const usd = solIn * solPrice;
          const tokensOut = usd / (rand() * 0.01 + 0.001);
          events.push(swap(SOL, solIn, token, tokensOut, usd, t, rand() < 0.5 ? rand() : 0));
          held.set(SOL, (held.get(SOL) ?? 0) - solIn);
          held.set(token, tokenHeld + tokensOut);
        } else if (tokenHeld > 0) {
          // Sell some or all of the token back to SOL.
          const frac = rand() < 0.3 ? 1 : 0.2 + rand() * 0.7;
          const tokensIn = tokenHeld * frac;
          const usd = tokensIn * (rand() * 0.02 + 0.0005);
          const solOut = usd / solPrice;
          events.push(swap(token, tokensIn, SOL, solOut, usd, t));
          held.set(token, tokenHeld - tokensIn);
          held.set(SOL, (held.get(SOL) ?? 0) + solOut);
        } else if (rand() < 0.5) {
          events.push(ev({
            type: "INCOME", tokenOutMint: SOL, amountOut: 0.1 + rand(),
            usdValue: (0.1 + rand()) * solPrice, timestamp: t,
          }));
        } else {
          events.push(ev({
            type: "SELF_TRANSFER", tokenInMint: SOL,
            amountIn: (held.get(SOL) ?? 0) / 2, timestamp: t,
          }));
        }
      }

      const result = new FifoEngine().process(events);
      const report = auditFifoResult(events, result);
      if (!report.ok) {
        throw new Error(
          `fuzz run ${run} failed: ${JSON.stringify(report.checks.filter((c) => !c.ok))}`,
        );
      }
      // Every check must actually run in the fuzz — nothing unresolved here.
      expect(report.checks.every((c) => !c.skipped)).toBe(true);
    }
  });
});

describe("fixture wallets", () => {
  it("audits cleanly on every fixture wallet", async () => {
    const fixturesDir = fileURLToPath(new URL("../../fixtures", import.meta.url));
    const entries = (await readdir(fixturesDir, { recursive: true })) as string[];

    // A flat $150/SOL stub feed so fixture events price deterministically.
    const feed = {
      getPriceAt: async (ts: number) => ({ atTimestamp: ts, price: 150, distanceSec: 0 }),
    } as unknown as SolPriceFeed;
    const pricer = new EventPricer(feed);

    const byWallet = new Map<string, NormalizedEvent[]>();
    for (const rel of entries.filter((e) => e.endsWith(".expected.json")).sort()) {
      const expected = JSON.parse(await readFile(join(fixturesDir, rel), "utf8")) as {
        wallet: string;
        events: NormalizedEvent[];
      };
      const list = byWallet.get(expected.wallet) ?? [];
      list.push(...expected.events);
      byWallet.set(expected.wallet, list);
    }
    expect(byWallet.size).toBeGreaterThan(0);

    for (const [wallet, events] of byWallet) {
      const priced: PricedEvent[] = [];
      for (const e of events) priced.push(await pricer.priceEvent(e));
      const result = new FifoEngine().process(priced);
      const report = auditFifoResult(priced, result);
      const failed = report.checks.filter((c) => !c.ok);
      expect(failed, `wallet ${wallet}: ${JSON.stringify(failed)}`).toEqual([]);
    }
  });
});
