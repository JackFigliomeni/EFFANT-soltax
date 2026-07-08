import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runFixtures } from "./fixtureRunner.js";

const fixturesDir = fileURLToPath(new URL("../../fixtures", import.meta.url));

describe("fixture suite", () => {
  it("classifies every fixture as expected", async () => {
    const report = await runFixtures(fixturesDir);

    expect(report.total).toBeGreaterThanOrEqual(20);
    const failing = report.outcomes
      .filter((o) => !o.passed)
      .map((o) => ({ name: o.name, failures: o.failures }));
    expect(failing).toEqual([]);
    expect(report.rate).toBe(1);
  });
});
