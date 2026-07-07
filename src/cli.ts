#!/usr/bin/env node
import "dotenv/config";
import { analyze, InvalidSolanaAddressError } from "./analyze.js";
import { HeliusClient } from "./helius/heliusClient.js";

function printUsage(): void {
  console.error("Usage: soltax analyze <solana-wallet-address>");
}

async function runAnalyze(address: string): Promise<void> {
  try {
    analyze(address);
  } catch (error) {
    if (error instanceof InvalidSolanaAddressError) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
  console.log(`Valid Solana address: ${address}`);

  const apiKey = process.env["HELIUS_API_KEY"];
  if (!apiKey) {
    console.error(
      "Error: HELIUS_API_KEY is not set. Add it to your .env file " +
        "(see .env.example) to fetch transaction history.",
    );
    process.exit(1);
  }

  const client = new HeliusClient({
    apiKey,
    cacheDir: process.env["SOLTAX_CACHE_DIR"] ?? ".cache/transactions",
  });

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
