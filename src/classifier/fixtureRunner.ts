import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HeliusParsedTransaction } from "../helius/types.js";
import { classifyTransaction } from "./classifier.js";
import type { NormalizedEvent } from "./types.js";

/**
 * A fixture is a pair of files anywhere under the fixtures directory:
 *   <name>.tx.json        — a saved parsed Helius transaction
 *   <name>.expected.json  — the hand-written expected classification
 */
export interface FixtureExpectation {
  /** The wallet the classification is relative to. */
  wallet: string;
  ownedWallets?: string[];
  events: NormalizedEvent[];
}

export interface FixtureOutcome {
  name: string;
  passed: boolean;
  failures: string[];
}

export interface FixtureReport {
  outcomes: FixtureOutcome[];
  passed: number;
  total: number;
  /** Fraction of fixtures classified correctly, 0-1. */
  rate: number;
}

const EVENT_FIELDS = [
  "signature",
  "timestamp",
  "type",
  "protocol",
  "tokenInMint",
  "amountIn",
  "tokenOutMint",
  "amountOut",
  "feeLamports",
] as const;

function approxEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

function compareEvents(
  actual: NormalizedEvent[],
  expected: NormalizedEvent[],
  failures: string[],
): void {
  if (actual.length !== expected.length) {
    failures.push(`expected ${expected.length} event(s), got ${actual.length}`);
    return;
  }
  for (let i = 0; i < expected.length; i++) {
    const exp = expected[i]!;
    const act = actual[i]!;
    for (const field of EVENT_FIELDS) {
      const e = exp[field];
      const a = act[field];
      const equal =
        typeof e === "number" && typeof a === "number"
          ? approxEqual(a, e)
          : a === e;
      if (!equal) {
        failures.push(
          `events[${i}].${field}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`,
        );
      }
    }
  }
}

export async function runFixtures(fixturesDir: string): Promise<FixtureReport> {
  const entries = (await readdir(fixturesDir, { recursive: true })) as string[];
  const txFiles = entries.filter((e) => e.endsWith(".tx.json")).sort();

  const outcomes: FixtureOutcome[] = [];
  for (const relPath of txFiles) {
    const name = relPath.slice(0, -".tx.json".length);
    const failures: string[] = [];

    const tx = JSON.parse(
      await readFile(join(fixturesDir, relPath), "utf8"),
    ) as HeliusParsedTransaction;

    let expectation: FixtureExpectation | undefined;
    try {
      expectation = JSON.parse(
        await readFile(join(fixturesDir, `${name}.expected.json`), "utf8"),
      ) as FixtureExpectation;
    } catch {
      failures.push(`missing or unreadable ${name}.expected.json`);
    }

    if (expectation) {
      const actual = [
        classifyTransaction(tx, {
          wallet: expectation.wallet,
          ownedWallets: expectation.ownedWallets ?? [],
        }),
      ];
      compareEvents(actual, expectation.events, failures);
    }

    outcomes.push({ name, passed: failures.length === 0, failures });
  }

  const passed = outcomes.filter((o) => o.passed).length;
  return {
    outcomes,
    passed,
    total: outcomes.length,
    rate: outcomes.length === 0 ? 0 : passed / outcomes.length,
  };
}
