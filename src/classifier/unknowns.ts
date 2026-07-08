import type { HeliusParsedTransaction } from "../helius/types.js";
import { classifyTransaction } from "./classifier.js";
import { PLUMBING_PROGRAMS } from "./programs.js";
import type { ClassifierContext } from "./types.js";

export interface UnknownTransaction {
  signature: string;
  timestamp: number;
  solscanUrl: string;
}

export interface UnknownGroup {
  /** The program most likely responsible for this transaction shape. */
  programId: string;
  count: number;
  transactions: UnknownTransaction[];
}

/**
 * Picks the transaction's "interesting" program: the first top-level
 * instruction that isn't generic plumbing (system/token/ATA/compute/memo).
 */
function primaryProgram(tx: HeliusParsedTransaction): string {
  const instructions = tx.instructions ?? [];
  for (const ix of instructions) {
    if (!PLUMBING_PROGRAMS.has(ix.programId)) return ix.programId;
  }
  return instructions[0]?.programId ?? "(no instructions)";
}

/**
 * Collects every transaction the classifier could not categorize, grouped by
 * primary program ID and sorted by frequency — a worklist of what to teach
 * the classifier next.
 */
export async function collectUnknowns(
  txs: AsyncIterable<HeliusParsedTransaction>,
  ctx: ClassifierContext,
): Promise<{ groups: UnknownGroup[]; unknownCount: number; totalCount: number }> {
  const byProgram = new Map<string, UnknownTransaction[]>();
  let unknownCount = 0;
  let totalCount = 0;

  for await (const tx of txs) {
    totalCount += 1;
    const event = classifyTransaction(tx, ctx);
    if (event.type !== "UNKNOWN") continue;
    unknownCount += 1;

    const program = primaryProgram(tx);
    let list = byProgram.get(program);
    if (!list) {
      list = [];
      byProgram.set(program, list);
    }
    list.push({
      signature: tx.signature,
      timestamp: tx.timestamp,
      solscanUrl: `https://solscan.io/tx/${tx.signature}`,
    });
  }

  const groups: UnknownGroup[] = [...byProgram.entries()]
    .map(([programId, transactions]) => ({
      programId,
      count: transactions.length,
      transactions: transactions.sort((a, b) => b.timestamp - a.timestamp),
    }))
    .sort((a, b) => b.count - a.count || a.programId.localeCompare(b.programId));

  return { groups, unknownCount, totalCount };
}
