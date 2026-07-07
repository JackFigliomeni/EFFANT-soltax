import { describe, expect, it } from "vitest";
import { analyze, InvalidSolanaAddressError } from "./analyze.js";

describe("analyze", () => {
  it("returns the address when valid", () => {
    const address = "So11111111111111111111111111111111111111112";
    expect(analyze(address)).toEqual({ address });
  });

  it("throws InvalidSolanaAddressError for an invalid address", () => {
    expect(() => analyze("not-a-real-address")).toThrow(InvalidSolanaAddressError);
  });
});
