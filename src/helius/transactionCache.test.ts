import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TransactionCache } from "./transactionCache.js";
import type { HeliusParsedTransaction } from "./types.js";

const WALLET = "So11111111111111111111111111111111111111112";

function makeTx(signature: string, timestamp = 1_700_000_000): HeliusParsedTransaction {
  return {
    signature,
    timestamp,
    slot: 1,
    type: "TRANSFER",
    source: "SYSTEM_PROGRAM",
    fee: 5000,
    feePayer: WALLET,
    description: "test transfer",
  };
}

describe("TransactionCache", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "soltax-cache-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("starts empty and incomplete", async () => {
    const cache = await TransactionCache.open(dir, WALLET);
    expect(cache.size).toBe(0);
    expect(cache.getMeta()).toEqual({ complete: false, total: 0 });
    await cache.close();
  });

  it("appends transactions and dedupes by signature", async () => {
    const cache = await TransactionCache.open(dir, WALLET);
    await cache.append(makeTx("sig1"));
    await cache.append(makeTx("sig2"));
    await cache.append(makeTx("sig1")); // duplicate ignored
    expect(cache.size).toBe(2);
    expect(cache.has("sig1")).toBe(true);
    expect(cache.has("sig3")).toBe(false);
    await cache.close();
  });

  it("persists across open/close cycles", async () => {
    const first = await TransactionCache.open(dir, WALLET);
    await first.append(makeTx("sig1"));
    await first.append(makeTx("sig2"));
    await first.updateMeta({ oldestSignature: "sig2", newestSignature: "sig1" });
    await first.close();

    const second = await TransactionCache.open(dir, WALLET);
    expect(second.size).toBe(2);
    expect(second.has("sig1")).toBe(true);
    expect(second.getMeta()).toEqual({
      complete: false,
      total: 2,
      oldestSignature: "sig2",
      newestSignature: "sig1",
    });
    await second.close();
  });

  it("streams back everything that was appended", async () => {
    const cache = await TransactionCache.open(dir, WALLET);
    for (let i = 0; i < 500; i++) {
      await cache.append(makeTx(`sig${i}`, 1_700_000_000 + i));
    }
    await cache.close();

    const reopened = await TransactionCache.open(dir, WALLET);
    const signatures: string[] = [];
    for await (const tx of reopened.readAll()) {
      signatures.push(tx.signature);
    }
    expect(signatures).toHaveLength(500);
    expect(signatures[0]).toBe("sig0");
    expect(signatures[499]).toBe("sig499");
    await reopened.close();
  });
});
