import bs58 from "bs58";

const BASE58_PATTERN = /^[1-9A-HJ-NP-Za-km-z]+$/;
const SOLANA_PUBKEY_BYTE_LENGTH = 32;

export class InvalidSolanaAddressError extends Error {
  constructor(address: string, reason: string) {
    super(`Invalid Solana wallet address "${address}": ${reason}`);
    this.name = "InvalidSolanaAddressError";
  }
}

/**
 * Validates that a string is a well-formed Solana wallet address:
 * base58-encoded and decodes to exactly 32 bytes (a public key).
 */
export function isValidSolanaAddress(address: string): boolean {
  if (address.length < 32 || address.length > 44) {
    return false;
  }
  if (!BASE58_PATTERN.test(address)) {
    return false;
  }
  try {
    return bs58.decode(address).length === SOLANA_PUBKEY_BYTE_LENGTH;
  } catch {
    return false;
  }
}

/**
 * Same check as isValidSolanaAddress, but throws with a specific reason
 * so the CLI can surface a clear, actionable error message.
 */
export function assertValidSolanaAddress(address: string): void {
  if (address.length < 32 || address.length > 44) {
    throw new InvalidSolanaAddressError(
      address,
      `expected 32-44 characters, got ${address.length}`,
    );
  }
  if (!BASE58_PATTERN.test(address)) {
    throw new InvalidSolanaAddressError(
      address,
      "contains characters outside the base58 alphabet",
    );
  }

  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(address);
  } catch {
    throw new InvalidSolanaAddressError(address, "not valid base58");
  }

  if (decoded.length !== SOLANA_PUBKEY_BYTE_LENGTH) {
    throw new InvalidSolanaAddressError(
      address,
      `decodes to ${decoded.length} bytes, expected ${SOLANA_PUBKEY_BYTE_LENGTH}`,
    );
  }
}
