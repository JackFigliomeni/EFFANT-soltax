#!/usr/bin/env node
import "dotenv/config";
import { analyze, InvalidSolanaAddressError } from "./analyze.js";

function printUsage(): void {
  console.error("Usage: soltax analyze <solana-wallet-address>");
}

function main(argv: string[]): void {
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

      try {
        const result = analyze(address);
        console.log(`Valid Solana address: ${result.address}`);
      } catch (error) {
        if (error instanceof InvalidSolanaAddressError) {
          console.error(`Error: ${error.message}`);
          process.exit(1);
        }
        throw error;
      }
      break;
    }
    default: {
      console.error(`Error: unknown command "${command}".`);
      printUsage();
      process.exit(1);
    }
  }
}

main(process.argv.slice(2));
