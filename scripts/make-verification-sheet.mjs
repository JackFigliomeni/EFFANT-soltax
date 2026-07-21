#!/usr/bin/env node
// Builds the hand-verification spreadsheet the build guide demands:
// ~20 diverse priced events with everything needed to recompute each USD
// value by hand and match it to the penny.
//
// Usage: npm run build && node scripts/make-verification-sheet.mjs <wallet>
// Output: reports/<wallet>/verification-sheet.csv
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import "dotenv/config";
import { classifyStream } from "../dist/classifier/classifier.js";
import { NATIVE_SOL_MINT } from "../dist/classifier/programs.js";
import { TransactionCache } from "../dist/helius/transactionCache.js";
import { EventPricer } from "../dist/pricing/eventPricer.js";
import { SolPriceFeed } from "../dist/pricing/solPriceFeed.js";

const wallet = process.argv[2];
if (!wallet) {
  console.error("Usage: node scripts/make-verification-sheet.mjs <wallet>");
  process.exit(1);
}

const TARGET = 20;

const cache = await TransactionCache.open(
  process.env.SOLTAX_CACHE_DIR ?? ".cache/transactions",
  wallet,
);
if (cache.size === 0) {
  console.error(`No cached history for ${wallet} — run "soltax analyze ${wallet}" first.`);
  process.exit(1);
}

const feed = new SolPriceFeed({
  cacheDir: process.env.SOLTAX_PRICE_CACHE_DIR ?? ".cache/prices/sol-usd",
});
const pricer = new EventPricer(feed);

const owned = (process.env.SOLTAX_OWNED_WALLETS ?? "")
  .split(",").map((w) => w.trim()).filter(Boolean);

const events = [];
for await (const e of pricer.priceEvents(
  classifyStream(cache.readAll(), { wallet, ownedWallets: owned }),
)) {
  if (e.usdValue !== null) events.push(e);
}
await cache.close();
events.sort((a, b) => a.timestamp - b.timestamp);

// Diverse sample: round-robin across (type, protocol) buckets so the sheet
// covers every venue and event kind the wallet actually used.
const buckets = new Map();
for (const e of events) {
  const key = `${e.type}:${e.protocol ?? "-"}`;
  const list = buckets.get(key) ?? [];
  list.push(e);
  buckets.set(key, list);
}
// Spread picks within each bucket: first, last, middle…
for (const list of buckets.values()) {
  list.sort((a, b) => a.timestamp - b.timestamp);
}
const sample = [];
let round = 0;
while (sample.length < TARGET) {
  let took = false;
  for (const list of buckets.values()) {
    if (sample.length >= TARGET) break;
    const pick = round === 0 ? 0 : round === 1 ? list.length - 1 : Math.floor(list.length / 2);
    const e = list[pick];
    if (e && !sample.includes(e)) {
      sample.push(e);
      took = true;
    }
  }
  round += 1;
  if (!took || round > 10) break;
}
sample.sort((a, b) => a.timestamp - b.timestamp);

const field = (v) => {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const line = (...fields) => fields.map(field).join(",");
const label = (mint) => (mint === NATIVE_SOL_MINT ? "SOL" : mint);

const rows = [
  line(
    "#", "Date (UTC)", "Type", "Protocol",
    "Sent amount", "Sent asset", "Received amount", "Received asset",
    "Price anchor", "SOL/USD used", "Candle distance (sec)",
    "Engine USD value", "Engine fee USD",
    "Your hand-computed USD", "Difference", "Match to the penny? (Y/N)",
    "Solscan link",
  ),
];
sample.forEach((e, i) => {
  rows.push(
    line(
      i + 1,
      new Date(e.timestamp * 1000).toISOString().replace("T", " ").slice(0, 19),
      e.type,
      e.protocol,
      e.amountIn, e.tokenInMint === null ? null : label(e.tokenInMint),
      e.amountOut, e.tokenOutMint === null ? null : label(e.tokenOutMint),
      e.priceSource,
      e.solUsd,
      e.priceDistanceSec,
      e.usdValue === null ? null : e.usdValue.toFixed(2),
      e.feeUsd === null ? null : e.feeUsd.toFixed(6),
      "", "", "",
      `https://solscan.io/tx/${e.signature}`,
    ),
  );
});
rows.push("");
rows.push(line("How to verify a SOL_LEG row:"));
rows.push(line("1. Open the Solscan link and confirm the sent/received amounts on-chain."));
rows.push(line("2. Look up SOL/USD at that minute on any exchange chart (e.g. Binance SOLUSDT 1m candle)."));
rows.push(line("3. Hand USD = SOL-side amount x SOL/USD. STABLE_LEG rows: hand USD = the USDC/USDT amount."));
rows.push(line("4. Difference = Engine USD value - your value. It should be pennies (candle-close vs your source)."));

const outDir = join("reports", wallet);
await mkdir(outDir, { recursive: true });
const outPath = join(outDir, "verification-sheet.csv");
await writeFile(outPath, rows.join("\n") + "\n", "utf8");
console.log(`Wrote ${sample.length} events to ${outPath}`);
console.log(`Buckets covered: ${[...buckets.keys()].join(", ")}`);
