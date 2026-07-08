#!/usr/bin/env node
import "dotenv/config";
import { analyze, InvalidSolanaAddressError } from "./analyze.js";
import { runFixtures } from "./classifier/fixtureRunner.js";
import { collectUnknowns } from "./classifier/unknowns.js";
import { HeliusClient } from "./helius/heliusClient.js";
import { TransactionCache } from "./helius/transactionCache.js";

function printUsage(): void {
  console.error(
    [
      "Usage: soltax <command>",
      "",
      "Commands:",
      "  analyze <solana-wallet-address>   validate the address and fetch full history",
      "  unknowns <solana-wallet-address>  list unclassified cached txs by program frequency",
      "  test-fixtures [dir]               run the classifier against fixtures (default: fixtures/)",
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
