#!/usr/bin/env node
import "dotenv/config";
import { analyze, InvalidSolanaAddressError } from "./analyze.js";
import { classifyStream, classifyTransaction } from "./classifier/classifier.js";
import { runFixtures } from "./classifier/fixtureRunner.js";
import { NATIVE_SOL_MINT } from "./classifier/programs.js";
import { collectUnknowns } from "./classifier/unknowns.js";
import { HeliusClient } from "./helius/heliusClient.js";
import { TransactionCache } from "./helius/transactionCache.js";
import { EventPricer, type PricedEvent } from "./pricing/eventPricer.js";
import { mergePortfolioEvents } from "./pricing/portfolio.js";
import { SolPriceFeed } from "./pricing/solPriceFeed.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { auditFifoResult } from "./tax/audit.js";
import { FifoEngine } from "./tax/fifoEngine.js";
import { buildReports } from "./tax/reports.js";

function printUsage(): void {
  console.error(
    [
      "Usage: soltax <command>",
      "",
      "Commands (multiple wallets = one merged portfolio; inter-wallet",
      "transfers become non-taxable SELF_TRANSFERs):",
      "",
      "  run <wallet>... [flags]          fetch + full tax report + benchmark, one shot",
      "  analyze <wallet>                 validate the address and fetch full history",
      "  events <wallet>... [flags]       classified events with USD values",
      "      --include-spam    keep SPAM and FAILED events in the output",
      "      --json            emit one JSON object per line instead of a table",
      "  gains <wallet>...                FIFO cost-basis report: gains, income, flags",
      "  report <wallet>... [flags]       write tax report files (8949, TurboTax, ledger)",
      "      --year YYYY       limit to one UTC calendar tax year",
      "      --out <dir>       output directory (default: reports/<wallet>)",
      "  unknowns <wallet>                list unclassified cached txs by program frequency",
      "  benchmark <wallet>...            classification-rate stats across wallets",
      "  test-fixtures [dir]              run the classifier against fixtures (default: fixtures/)",
    ].join("\n"),
  );
}

function cacheDir(): string {
  return process.env["SOLTAX_CACHE_DIR"] ?? ".cache/transactions";
}

function ownedWallets(): string[] {
  return (process.env["SOLTAX_OWNED_WALLETS"] ?? "")
    .split(",")
    .map((w) => w.trim())
    .filter((w) => w.length > 0);
}

/**
 * Resolves the Helius API key, tolerating the two mistakes that are easy to
 * make when setting up .env: pasting a full Helius RPC URL instead of the
 * bare key, and surrounding quotes. Returns the 32-hex-with-dashes key, or
 * null with a clear reason if unusable.
 */
function resolveHeliusApiKey(): { key: string } | { error: string } {
  let raw = (process.env["HELIUS_API_KEY"] ?? "").trim().replace(/^["']|["']$/g, "");
  if (!raw) {
    return {
      error:
        "HELIUS_API_KEY is not set. Add it to your .env file as a single line:\n" +
        "  HELIUS_API_KEY=your-key-here\n" +
        "Get a free key at https://dashboard.helius.dev (no https://, no quotes).",
    };
  }
  // Someone pasted the whole RPC URL — pull the key out of it.
  if (raw.includes("api-key=")) {
    const match = /api-key=([0-9a-fA-F-]{36})/.exec(raw);
    if (match) raw = match[1]!;
  }
  if (!/^[0-9a-fA-F-]{36}$/.test(raw)) {
    return {
      error:
        `HELIUS_API_KEY doesn't look like a valid key (got ${raw.length} chars). ` +
        "It should be a 36-character UUID. Copy it from https://dashboard.helius.dev.",
    };
  }
  return { key: raw };
}

function requireHeliusKeyOrExit(): string {
  const resolved = resolveHeliusApiKey();
  if ("error" in resolved) {
    console.error(`Error: ${resolved.error}`);
    process.exit(1);
  }
  return resolved.key;
}

function validateAddressOrExit(address: string): void {
  try {
    analyze(address);
  } catch (error) {
    if (error instanceof InvalidSolanaAddressError) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

async function runAnalyze(address: string): Promise<void> {
  validateAddressOrExit(address);
  console.log(`Valid Solana address: ${address}`);

  const apiKey = requireHeliusKeyOrExit();
  const client = new HeliusClient({ apiKey, cacheDir: cacheDir() });

  console.log("Fetching transaction history from Helius...");
  const result = await client.fetchHistory(address, {
    onProgress: (p) => {
      process.stdout.write(
        `\r  pages: ${p.pages}  fetched: ${p.fetched}  already cached: ${p.cached}   `,
      );
    },
  });
  process.stdout.write("\n");

  console.log(
    `Done. ${result.total} transactions in cache ` +
      `(${result.fetched} newly fetched this run).`,
  );
  console.log(`Cache file: ${result.cacheFile}`);
}

function fmtMint(mint: string): string {
  return mint === NATIVE_SOL_MINT ? "SOL" : `${mint.slice(0, 8)}…`;
}

function fmtAmount(n: number): string {
  return n >= 1_000_000
    ? n.toLocaleString("en-US", { maximumFractionDigits: 0 })
    : n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function fmtEventLine(e: PricedEvent): string {
  const when = new Date(e.timestamp * 1000).toISOString().slice(0, 16).replace("T", " ");
  const type = e.type.padEnd(13);
  const proto = (e.protocol ?? "").padEnd(12);
  const gave = e.tokenInMint !== null && e.amountIn !== null
    ? `-${fmtAmount(e.amountIn)} ${fmtMint(e.tokenInMint)}`
    : "";
  const got = e.tokenOutMint !== null && e.amountOut !== null
    ? `+${fmtAmount(e.amountOut)} ${fmtMint(e.tokenOutMint)}`
    : "";
  const legs = [gave, got].filter(Boolean).join(" → ").padEnd(44);
  const value = e.needsPrice
    ? "NEEDS_PRICE"
    : e.usdValue !== null
      ? `$${e.usdValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : "";
  return `${when}  ${type} ${proto} ${legs} ${value}`;
}

/** Splits CLI args into leading wallet addresses and trailing --flags. */
function splitArgs(rest: string[]): { addresses: string[]; flags: string[] } {
  const firstFlag = rest.findIndex((a) => a.startsWith("--"));
  const addresses = firstFlag === -1 ? rest : rest.slice(0, firstFlag);
  const flags = firstFlag === -1 ? [] : rest.slice(firstFlag);
  return { addresses, flags };
}

/**
 * Streams every wallet's cache -> classifier -> pricer, then merges the
 * per-wallet streams into one chronological portfolio (one event per
 * signature). Each wallet is classified with the other wallets as owned, so
 * inter-wallet transfers become SELF_TRANSFERs.
 */
async function collectPortfolioEvents(
  addresses: string[],
  includeSpam: boolean,
  quiet: boolean,
): Promise<PricedEvent[]> {
  const feed = new SolPriceFeed({
    cacheDir: process.env["SOLTAX_PRICE_CACHE_DIR"] ?? ".cache/prices/sol-usd",
    ...(process.env["COINGECKO_API_KEY"] && {
      coinGeckoApiKey: process.env["COINGECKO_API_KEY"],
    }),
  });
  const pricer = new EventPricer(feed);
  const envOwned = ownedWallets();

  const all: PricedEvent[] = [];
  for (const address of addresses) {
    const cache = await TransactionCache.open(cacheDir(), address);
    try {
      if (cache.size === 0) {
        console.error(
          `Error: no cached history for ${address}. Run "soltax analyze ${address}" first.`,
        );
        process.exit(1);
      }

      const owned = [...new Set([...addresses.filter((a) => a !== address), ...envOwned])];
      const stream = classifyStream(cache.readAll(), {
        wallet: address,
        ownedWallets: owned,
        includeSpam,
      });
      for await (const priced of pricer.priceEvents(stream)) {
        all.push(priced);
        if (!quiet) process.stderr.write(`\r  pricing… ${all.length}`);
      }
    } finally {
      await cache.close();
    }
  }
  if (!quiet) process.stderr.write("\r");
  return mergePortfolioEvents(all);
}

function portfolioLabel(addresses: string[]): string {
  return addresses.length === 1
    ? addresses[0]!
    : `portfolio of ${addresses.length} wallets: ${addresses.join(", ")}`;
}

function defaultOutDir(addresses: string[]): string {
  return addresses.length === 1
    ? join("reports", addresses[0]!)
    : join("reports", `portfolio-${addresses.length}w-${addresses[0]!.slice(0, 8)}`);
}

function usd(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

async function runGains(addresses: string[]): Promise<void> {
  for (const address of addresses) validateAddressOrExit(address);
  const events = await collectPortfolioEvents(addresses, false, false);
  const result = new FifoEngine().process(events);
  const t = result.totals;

  console.log(`FIFO cost-basis report for ${portfolioLabel(addresses)}\n`);
  console.log(`  Short-term gain/loss   ${usd(t.shortTermGainUsd)}`);
  console.log(`  Long-term gain/loss    ${usd(t.longTermGainUsd)}`);
  console.log(`  Ordinary income        ${usd(t.ordinaryIncomeUsd)}`);
  console.log(
    `\n  Disposals: ${result.disposals.length} ` +
      `(${t.unresolvedDisposals} unresolved — no basis invented)`,
  );
  console.log(`  Income events: ${result.income.length}`);
  console.log(`  Open positions: ${result.openLots.length} lots\n`);

  if (result.flags.length > 0) {
    const byKind = new Map<string, number>();
    for (const f of result.flags) byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1);
    console.log("  Flagged for review:");
    for (const [kind, count] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${kind.padEnd(20)} ${count}`);
    }
    console.log(
      `\n  Every flag has a signature — use \`soltax events ${addresses.join(" ")} --json\`` +
        " to inspect, or the fixtures loop to teach the classifier.",
    );
  } else {
    console.log("  No flags — every disposal fully resolved.");
  }

  const audit = auditFifoResult(events, result);
  console.log(`\n  Math audit: ${audit.ok ? "PASS" : "FAIL"}`);
  for (const c of audit.checks) {
    const mark = c.skipped ? "–" : c.ok ? "✓" : "✗";
    console.log(`    ${mark} ${c.name}: ${c.detail}`);
  }
  if (!audit.ok) {
    console.error("\nError: the math audit failed — numbers above are not trustworthy.");
    process.exit(1);
  }
}

async function runReport(addresses: string[], flags: string[]): Promise<void> {
  for (const address of addresses) validateAddressOrExit(address);

  const yearIdx = flags.indexOf("--year");
  const year = yearIdx >= 0 ? Number(flags[yearIdx + 1]) : undefined;
  if (yearIdx >= 0 && (!Number.isInteger(year) || year! < 2020 || year! > 2100)) {
    console.error("Error: --year requires a valid year, e.g. --year 2025");
    process.exit(1);
  }
  const outIdx = flags.indexOf("--out");
  const outDir = outIdx >= 0 && flags[outIdx + 1]
    ? flags[outIdx + 1]!
    : defaultOutDir(addresses);

  // Ledger wants every transaction, spam included; the engine ignores
  // SPAM/FAILED internally, so one collection serves both.
  const events = await collectPortfolioEvents(addresses, true, false);
  const result = new FifoEngine().process(events);
  const audit = auditFifoResult(events, result);

  if (!audit.ok) {
    console.error("Error: the math audit failed — refusing to write reports:");
    for (const c of audit.checks.filter((x) => !x.ok)) {
      console.error(`  ✗ ${c.name}: ${c.detail}`);
    }
    process.exit(1);
  }

  const bundle = buildReports(events, result, {
    wallet: portfolioLabel(addresses),
    ...(year !== undefined && { year }),
    audit,
  });

  await mkdir(outDir, { recursive: true });
  for (const [name, content] of bundle.files) {
    await writeFile(join(outDir, name), content, "utf8");
  }

  console.log(bundle.summaryText);
  console.log(`Files written to ${outDir}/:`);
  for (const name of bundle.files.keys()) console.log(`  ${name}`);
}

async function runEvents(addresses: string[], flags: string[]): Promise<void> {
  for (const address of addresses) validateAddressOrExit(address);
  const includeSpam = flags.includes("--include-spam");
  const asJson = flags.includes("--json");
  const events = await collectPortfolioEvents(addresses, includeSpam, asJson);

  if (asJson) {
    for (const e of events) console.log(JSON.stringify(e));
    return;
  }

  for (const e of events) console.log(fmtEventLine(e));

  const priced = events.filter((e) => e.usdValue !== null).length;
  const needing = events.filter((e) => e.needsPrice).length;
  const feesUsd = events.reduce((s, e) => s + (e.feeUsd ?? 0), 0);
  console.log(
    `\n${events.length} events · ${priced} priced · ${needing} NEEDS_PRICE · ` +
      `network fees $${feesUsd.toFixed(2)}`,
  );
}

async function runUnknowns(address: string): Promise<void> {
  validateAddressOrExit(address);

  const cache = await TransactionCache.open(cacheDir(), address);
  try {
    if (cache.size === 0) {
      console.error(
        `Error: no cached history for ${address}. Run "soltax analyze ${address}" first.`,
      );
      process.exit(1);
    }

    const { groups, unknownCount, totalCount } = await collectUnknowns(
      cache.readAll(),
      { wallet: address, ownedWallets: ownedWallets() },
    );

    console.log(`Unclassified transactions: ${unknownCount} of ${totalCount} cached\n`);
    for (const group of groups) {
      console.log(`${group.programId} — ${group.count} transaction(s)`);
      for (const t of group.transactions) {
        const when = new Date(t.timestamp * 1000).toISOString();
        console.log(`  ${t.solscanUrl}  ${when}`);
      }
      console.log("");
    }
    if (unknownCount === 0) {
      console.log("Everything classified — worklist is empty.");
    }
  } finally {
    await cache.close();
  }
}

async function runBenchmark(addresses: string[]): Promise<void> {
  for (const address of addresses) validateAddressOrExit(address);

  interface Row {
    wallet: string;
    total: number;
    unknown: number;
    spam: number;
  }
  const rows: Row[] = [];

  for (const address of addresses) {
    let cache = await TransactionCache.open(cacheDir(), address);
    if (cache.size === 0) {
      await cache.close();
      const resolved = resolveHeliusApiKey();
      if ("error" in resolved) {
        console.error(
          `Error: ${address} is not cached and no usable key — ${resolved.error}`,
        );
        process.exit(1);
      }
      process.stderr.write(`fetching ${address}…\n`);
      const client = new HeliusClient({ apiKey: resolved.key, cacheDir: cacheDir() });
      await client.fetchHistory(address);
      cache = await TransactionCache.open(cacheDir(), address);
    }

    try {
      let total = 0;
      let unknown = 0;
      let spam = 0;
      for await (const tx of cache.readAll()) {
        const event = classifyTransaction(tx, {
          wallet: address,
          ownedWallets: ownedWallets(),
        });
        total += 1;
        if (event.type === "UNKNOWN") unknown += 1;
        if (event.type === "SPAM" || event.type === "FAILED") spam += 1;
      }
      rows.push({ wallet: address, total, unknown, spam });
    } finally {
      await cache.close();
    }
  }

  const pct = (n: number, d: number): string =>
    d === 0 ? "—" : `${((n / d) * 100).toFixed(1)}%`;

  console.log(`SOLTAX classification benchmark — ${new Date().toISOString().slice(0, 10)}\n`);
  console.log(
    "Wallet".padEnd(46) + "Txs".padStart(8) + "Classified".padStart(12) +
      "Unknown".padStart(9) + "Spam".padStart(8),
  );
  console.log("-".repeat(83));
  let totalTxs = 0;
  let totalUnknown = 0;
  for (const r of rows) {
    totalTxs += r.total;
    totalUnknown += r.unknown;
    console.log(
      r.wallet.padEnd(46) + String(r.total).padStart(8) +
        pct(r.total - r.unknown, r.total).padStart(12) +
        String(r.unknown).padStart(9) + pct(r.spam, r.total).padStart(8),
    );
  }
  console.log("-".repeat(83));
  console.log(
    "TOTAL".padEnd(46) + String(totalTxs).padStart(8) +
      pct(totalTxs - totalUnknown, totalTxs).padStart(12) +
      String(totalUnknown).padStart(9),
  );
}

/** One-shot volunteer flow: fetch every wallet, write the report, benchmark. */
async function runRun(addresses: string[], flags: string[]): Promise<void> {
  for (const address of addresses) validateAddressOrExit(address);

  const resolved = resolveHeliusApiKey();
  const apiKey = "key" in resolved ? resolved.key : null;
  for (const address of addresses) {
    if (apiKey) {
      const client = new HeliusClient({ apiKey, cacheDir: cacheDir() });
      process.stderr.write(`fetching ${address}…`);
      const result = await client.fetchHistory(address);
      process.stderr.write(` ${result.total} txs (${result.fetched} new)\n`);
    } else {
      const cache = await TransactionCache.open(cacheDir(), address);
      const cached = cache.size;
      await cache.close();
      if (cached === 0) {
        console.error(`Error: ${address} is not cached — ${(resolved as { error: string }).error}`);
        process.exit(1);
      }
      process.stderr.write(`no API key — using ${cached} cached txs for ${address}\n`);
    }
  }

  await runReport(addresses, flags);
  console.log("");
  await runBenchmark(addresses);
}

async function runTestFixtures(dir: string): Promise<void> {
  const report = await runFixtures(dir);

  for (const outcome of report.outcomes) {
    console.log(`${outcome.passed ? "PASS" : "FAIL"}  ${outcome.name}`);
    for (const failure of outcome.failures) {
      console.log(`        ${failure}`);
    }
  }
  const pct = (report.rate * 100).toFixed(1);
  console.log(`\n${report.passed}/${report.total} fixtures passed (${pct}% classification rate)`);
  if (report.passed !== report.total) {
    process.exit(1);
  }
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;

  if (!command) {
    printUsage();
    process.exit(1);
  }

  switch (command) {
    case "analyze": {
      const address = rest[0];
      if (!address) {
        console.error("Error: missing <solana-wallet-address> argument.");
        printUsage();
        process.exit(1);
      }
      await runAnalyze(address);
      break;
    }
    case "run":
    case "events":
    case "report":
    case "gains": {
      const { addresses, flags } = splitArgs(rest);
      if (addresses.length === 0) {
        console.error("Error: missing <solana-wallet-address> argument(s).");
        printUsage();
        process.exit(1);
      }
      if (command === "run") await runRun(addresses, flags);
      else if (command === "events") await runEvents(addresses, flags);
      else if (command === "report") await runReport(addresses, flags);
      else await runGains(addresses);
      break;
    }
    case "unknowns": {
      const address = rest[0];
      if (!address) {
        console.error("Error: missing <solana-wallet-address> argument.");
        printUsage();
        process.exit(1);
      }
      await runUnknowns(address);
      break;
    }
    case "benchmark": {
      if (rest.length === 0) {
        console.error("Error: benchmark needs at least one wallet address.");
        printUsage();
        process.exit(1);
      }
      await runBenchmark(rest);
      break;
    }
    case "test-fixtures": {
      await runTestFixtures(rest[0] ?? "fixtures");
      break;
    }
    default: {
      console.error(`Error: unknown command "${command}".`);
      printUsage();
      process.exit(1);
    }
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
