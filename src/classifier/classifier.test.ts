import { describe, expect, it } from "vitest";
import type { HeliusParsedTransaction } from "../helius/types.js";
import { classifyTransaction, classifyTransactions } from "./classifier.js";
import { NATIVE_SOL_MINT } from "./programs.js";

const USER = "UserWa11etMain111111111111111111111111111111";
const OTHER = "FriendWa11et11111111111111111111111111111111";
const COLD = "UserWa11etCo1d111111111111111111111111111111";

let seq = 0;
function makeTx(overrides: Partial<HeliusParsedTransaction>): HeliusParsedTransaction {
  seq += 1;
  return {
    signature: `unit-sig-${seq}`,
    timestamp: 1_735_689_600 + seq,
    slot: seq,
    type: "TRANSFER",
    source: "SYSTEM_PROGRAM",
    fee: 5000,
    feePayer: USER,
    description: "",
    ...overrides,
  };
}

describe("owned wallets", () => {
  const toCold = makeTx({
    nativeTransfers: [{ fromUserAccount: USER, toUserAccount: COLD, amount: 1_000_000_000 }],
  });

  it("classifies transfers between owned wallets as SELF_TRANSFER", () => {
    const event = classifyTransaction(toCold, { wallet: USER, ownedWallets: [COLD] });
    expect(event.type).toBe("SELF_TRANSFER");
  });

  it("classifies the same transfer as TRANSFER_OUT without the owned list", () => {
    const event = classifyTransaction(toCold, { wallet: USER });
    expect(event.type).toBe("TRANSFER_OUT");
    expect(event.tokenInMint).toBe(NATIVE_SOL_MINT);
    expect(event.amountIn).toBeCloseTo(1.0, 9);
  });
});

describe("spam and failed filtering", () => {
  const legit = makeTx({
    nativeTransfers: [{ fromUserAccount: USER, toUserAccount: OTHER, amount: 500_000_000 }],
  });
  const dust = makeTx({
    feePayer: OTHER,
    nativeTransfers: [{ fromUserAccount: OTHER, toUserAccount: USER, amount: 900 }],
  });
  const failed = makeTx({
    transactionError: { InstructionError: [0, "Custom"] },
  });

  it("excludes SPAM and FAILED from tax events by default", () => {
    const events = classifyTransactions([legit, dust, failed], { wallet: USER });
    expect(events.map((e) => e.type)).toEqual(["TRANSFER_OUT"]);
  });

  it("keeps SPAM and FAILED with the includeSpam override", () => {
    const events = classifyTransactions([legit, dust, failed], {
      wallet: USER,
      includeSpam: true,
    });
    expect(events.map((e) => e.type)).toEqual(["TRANSFER_OUT", "SPAM", "FAILED"]);
  });

  it("respects a custom dust threshold", () => {
    const event = classifyTransaction(dust, { wallet: USER, dustThresholdLamports: 100 });
    expect(event.type).toBe("TRANSFER_IN"); // 900 lamports is above the custom threshold
  });
});
