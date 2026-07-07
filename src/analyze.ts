import { assertValidSolanaAddress, InvalidSolanaAddressError } from "./solanaAddress.js";

export interface AnalyzeResult {
  address: string;
}

/**
 * Runs the "analyze" command for a wallet address. Kept separate from the
 * CLI entry point so it can be unit tested without touching process.exit.
 */
export function analyze(address: string): AnalyzeResult {
  assertValidSolanaAddress(address);
  return { address };
}

export { InvalidSolanaAddressError };
