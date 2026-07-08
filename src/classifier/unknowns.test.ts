import { describe, expect, it } from "vitest";
import type { HeliusParsedTransaction } from "../helius/types.js";
import { collectUnknowns } from "./unknowns.js";

const USER = "UserWa11etMain111111111111111111111111111111";
const POOL = "MysteryPoo1Vau1t1111111111111111111111111111";
const DEX_A = "MysteryDexProgramA11111111111111111111111111";
const DEX_B = "MysteryDexProgramB11111111111111111111111111";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

let seq = 0;
function unknownSwap(programId: string): HeliusParsedTransaction {
  seq += 1;
  return {
    signature: `unknown-sig-${seq}`,
    timestamp: 1_735_689_600 + seq,
    slot: seq,
    type: "UNKNOWN",
    source: "UNKNOWN",
    fee: 5000,
    feePayer: USER,
    description: "",
    tokenTransfers: [
      {
        fromUserAccount: USER, toUserAccount: POOL, mint: USDC, tokenAmount: 10,
      },
      {
        fromUserAccount: POOL, toUserAccount: USER, mint: BONK, tokenAmount: 1000,
      },
    ],
    // Compute budget noise first: grouping must skip plumbing programs.
    instructions: [
      { programId: COMPUTE_BUDGET },
      { programId },
    ],
  };
}

function plainTransfer(): HeliusParsedTransaction {
  seq += 1;
  return {
    signature: `transfer-sig-${seq}`,
    timestamp: 1_735_689_600 + seq,
    slot: seq,
    type: "TRANSFER",
    source: "SYSTEM_PROGRAM",
    fee: 5000,
    feePayer: USER,
    description: "",
    nativeTransfers: [
      { fromUserAccount: USER, toUserAccount: POOL, amount: 100_000_000 },
    ],
    instructions: [{ programId: "11111111111111111111111111111111" }],
  };
}

async function* stream(txs: HeliusParsedTransaction[]) {
  for (const tx of txs) yield tx;
}

describe("collectUnknowns", () => {
  it("groups unclassified txs by primary program, sorted by frequency", async () => {
    const txs = [
      unknownSwap(DEX_A),
      plainTransfer(),
      unknownSwap(DEX_B),
      unknownSwap(DEX_A),
    ];

    const { groups, unknownCount, totalCount } = await collectUnknowns(
      stream(txs),
      { wallet: USER },
    );

    expect(totalCount).toBe(4);
    expect(unknownCount).toBe(3);
    expect(groups.map((g) => [g.programId, g.count])).toEqual([
      [DEX_A, 2],
      [DEX_B, 1],
    ]);

    const first = groups[0]!.transactions[0]!;
    expect(first.solscanUrl).toBe(`https://solscan.io/tx/${first.signature}`);
  });

  it("returns no groups when everything classifies", async () => {
    const { groups, unknownCount } = await collectUnknowns(
      stream([plainTransfer()]),
      { wallet: USER },
    );
    expect(groups).toEqual([]);
    expect(unknownCount).toBe(0);
  });
});
