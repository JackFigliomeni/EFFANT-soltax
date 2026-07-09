#!/usr/bin/env node
import "dotenv/config";
import { analyze, InvalidSolanaAddressError } from "./analyze.js";
import { classifyStream } from "./classifier/classifier.js";
import { runFixtures } from "./classifier/fixtureRunner.js";
import { NATIVE_SOL_MINT } from "./classifier/programs.js";
import { collectUnknowns } from "./classifier/unknowns.js";
import { HeliusClient } from "./helius/heliusClient.js";
import { TransactionCache } from "./helius/transactionCache.js";
import { EventPricer, type PricedEvent } from "./pricing/eventPricer.js";
import { SolPriceFeed } from "./pricing/solPriceFeed.js";
import { FifoEngine } from "./tax/fifoEngine.js";

function printUsage(): void {
  console.error(
    [
      "Usage: soltax <command>",
      "",
      "Commands:",
      "  analyze <solana-wallet-address>            validate the address and fetch full history",
      "  events <solana-wallet-address> [flags]     classified events with USD values",
      "      --include-spam    keep SPAM and FAILED events in the output",
      "      --json            emit one JSON object per line instead of a table",
      "  gains <solana-wallet-address>              FIFO cost-basis report: gains, income, flags",
      "  unknowns <solana-wallet-address>           list unclassified cached txs by program frequency",
      "  test-fixtures [dir]                        run the classifier against fixtures (default: fixtures/)",
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

  const apiKey = process.env["HELIUS_API_KEY"];
  if (!apiKey) {
    console.error(
      "Error: HELIUS_API_KEY is not set. Add it to your .env file " +
        "(see .env.example) to fetch transaction history.",
    );
    process.exit(1);
  }

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

/** Streams cache -> classifier -> pricer and returns chronological events. */
async function collectPricedEvents(
  address: string,
  includeSpam: boolean,
  quiet: boolean,
): Promise<PricedEvent[]> {
  const cache = await TransactionCache.open(cacheDir(), address);
  try {
    if (cache.size === 0) {
      console.error(
        `Error: no cached history for ${address}. Run "soltax analyze ${address}" first.`,
      );
      process.exit(1);
    }

    const feed = new SolPriceFeed({
      cacheDir: process.env["SOLTAX_PRICE_CACHE_DIR"] ?? ".cache/prices/sol-usd",
      ...(process.env["COINGECKO_API_KEY"] && {
        coinGeckoApiKey: process.env["COINGECKO_API_KEY"],
      }),
    });
    const pricer = new EventPricer(feed);

    const events: PricedEvent[] = [];
    const stream = classifyStream(cache.readAll(), {
      wallet: address,
      ownedWallets: ownedWallets(),
      includeSpam,
    });
    for await (const priced of pricer.priceEvents(stream)) {
      events.push(priced);
      if (!quiet) process.stderr.write(`\r  pricing… ${events.length}`);
    }
    if (!quiet) process.stderr.write("\r");
    events.sort((a, b) => a.timestamp - b.timestamp);
    return events;
  } finally {
    await cache.close();
  }
}

function usd(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

async function runGains(address: string): Promise<void> {
  validateAddressOrExit(address);
  const events = await collectPricedEvents(address, false, false);
  const result = new FifoEngine().process(events);
  const t = result.totals;

  console.log(`FIFO cost-basis report for ${address}\n`);
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
      `\n  Every flag has a signature — use \`soltax events ${address} --json\`` +
        " to inspect, or the fixtures loop to teach the classifier.",
    );
  } else {
    console.log("  No flags — every disposal fully resolved.");
  }
}

async function runEvents(address: string, flags: string[]): Promise<void> {
  validateAddressOrExit(address);
  const includeSpam = flags.includes("--include-spam");
  const asJson = flags.includes("--json");
  const events = await collectPricedEvents(address, includeSpam, asJson);

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
    case "events": {
      const address = rest[0];
      if (!address) {
        console.error("Error: missing <solana-wallet-address> argument.");
        printUsage();
        process.exit(1);
      }
      await runEvents(address, rest.slice(1));
      break;
    }
    case "gains": {
      const address = rest[0];
      if (!address) {
        console.error("Error: missing <solana-wallet-address> argument.");
        printUsage();
        process.exit(1);
      }
      await runGains(address);
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
