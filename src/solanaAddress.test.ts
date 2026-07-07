import { describe, expect, it } from "vitest";
import {
  assertValidSolanaAddress,
  InvalidSolanaAddressError,
  isValidSolanaAddress,
} from "./solanaAddress.js";

const VALID_ADDRESSES = [
  "11111111111111111111111111111111", // System Program
  "So11111111111111111111111111111111111111112", // Wrapped SOL mint
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // Token Program
];

describe("isValidSolanaAddress", () => {
  it.each(VALID_ADDRESSES)("accepts a valid address: %s", (address) => {
    expect(isValidSolanaAddress(address)).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(isValidSolanaAddress("")).toBe(false);
  });

  it("rejects a too-short string", () => {
    expect(isValidSolanaAddress("abc123")).toBe(false);
  });

  it("rejects a too-long string", () => {
    expect(isValidSolanaAddress("1".repeat(50))).toBe(false);
  });

  it("rejects characters outside the base58 alphabet (0, O, I, l)", () => {
    expect(isValidSolanaAddress("0OIl1111111111111111111111111111")).toBe(false);
  });

  it("rejects a base58 string that doesn't decode to 32 bytes", () => {
    expect(isValidSolanaAddress("z".repeat(44))).toBe(false);
  });
});

describe("assertValidSolanaAddress", () => {
  it.each(VALID_ADDRESSES)("does not throw for a valid address: %s", (address) => {
    expect(() => assertValidSolanaAddress(address)).not.toThrow();
  });

  it("throws InvalidSolanaAddressError for a too-short address", () => {
    expect(() => assertValidSolanaAddress("short")).toThrow(InvalidSolanaAddressError);
  });

  it("throws with a message mentioning the base58 alphabet for invalid characters", () => {
    expect(() => assertValidSolanaAddress("0OIl1111111111111111111111111111")).toThrow(
      /base58 alphabet/,
    );
  });

  it("throws with a message mentioning decoded byte length for wrong-length payloads", () => {
    expect(() => assertValidSolanaAddress("z".repeat(44))).toThrow(/decodes to \d+ bytes/);
  });
});
