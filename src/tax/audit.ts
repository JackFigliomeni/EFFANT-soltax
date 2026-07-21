import type { PricedEvent } from "../pricing/eventPricer.js";
import type { FifoResult } from "./fifoEngine.js";

export interface AuditCheck {
  name: string;
  ok: boolean;
  /** True when preconditions weren't met and the check could not run. */
  skipped: boolean;
  detail: string;
}

export interface AuditReport {
  ok: boolean;
  checks: AuditCheck[];
}

/** A cent of tolerance for USD sums; relative tolerance for token amounts. */
const USD_TOLERANCE = 0.01;

function approxZero(n: number, scale: number): boolean {
  return Math.abs(n) <= Math.max(1e-6, scale * 1e-9);
}

/**
 * Self-audit for FIFO engine output — the guard against silent corruption.
 *
 * Checks, strongest last:
 *  1. Row arithmetic: every resolved disposal satisfies
 *     gain = proceeds − basis.
 *  2. Amount conservation per asset: units acquired equal units disposed
 *     (covered) plus units still open. (Assets touched by withdrawals or
 *     missing history are skipped — their unit flow is flagged, not silent.)
 *  3. USD conservation — the C4 invariant. Money can't appear or vanish:
 *       total gains = open-lot basis − deposits − income − capitalized fees
 *                     + withdrawn basis
 *     For a fully-closed wallet (no open token lots, no withdrawals) this
 *     reduces to: gains = net USD out − net USD in. Runs only when every
 *     value resolved (no NEEDS_PRICE / MISSING_HISTORY / UNKNOWN).
 */
export function auditFifoResult(
  events: PricedEvent[],
  result: FifoResult,
): AuditReport {
  const checks: AuditCheck[] = [];

  // ---- 1. Row arithmetic ----
  let badRows = 0;
  for (const d of result.disposals) {
    if (d.proceedsUsd !== null && d.costBasisUsd !== null) {
      if (
        d.gainLossUsd === null ||
        !approxZero(d.gainLossUsd - (d.proceedsUsd - d.costBasisUsd), Math.abs(d.proceedsUsd))
      ) {
        badRows += 1;
      }
    } else if (d.gainLossUsd !== null) {
      badRows += 1;
    }
  }
  checks.push({
    name: "disposal arithmetic",
    ok: badRows === 0,
    skipped: false,
    detail:
      badRows === 0
        ? `${result.disposals.length} disposal rows verified`
        : `${badRows} rows where gain ≠ proceeds − basis`,
  });

  // ---- 2. Amount conservation per asset ----
  const acquired = new Map<string, number>();
  const skippedAssets = new Set<string>();
  for (const e of events) {
    if (e.type === "TRANSFER_OUT" && e.tokenInMint !== null) {
      skippedAssets.add(e.tokenInMint);
    }
    const acquiring =
      (e.type === "SWAP" || e.type === "TRANSFER_IN" || e.type === "INCOME") &&
      e.tokenOutMint !== null && e.amountOut !== null && e.amountOut > 0;
    if (acquiring) {
      acquired.set(e.tokenOutMint!, (acquired.get(e.tokenOutMint!) ?? 0) + e.amountOut!);
    }
  }
  for (const d of result.disposals) {
    if (d.flags.includes("MISSING_HISTORY")) skippedAssets.add(d.asset);
  }

  const consumed = new Map<string, number>();
  for (const d of result.disposals) {
    if (d.acquiredAt !== null) {
      consumed.set(d.asset, (consumed.get(d.asset) ?? 0) + d.amount);
    }
  }
  for (const lot of result.openLots) {
    consumed.set(lot.asset, (consumed.get(lot.asset) ?? 0) + lot.amount);
  }

  let badAssets = 0;
  let checkedAssets = 0;
  for (const [asset, acq] of acquired) {
    if (skippedAssets.has(asset)) continue;
    checkedAssets += 1;
    const used = consumed.get(asset) ?? 0;
    if (!approxZero(acq - used, acq)) badAssets += 1;
  }
  checks.push({
    name: "amount conservation",
    ok: badAssets === 0,
    skipped: false,
    detail:
      badAssets === 0
        ? `${checkedAssets} assets balanced` +
          (skippedAssets.size > 0 ? ` (${skippedAssets.size} skipped: withdrawals/missing history)` : "")
        : `${badAssets} assets where acquired ≠ disposed + open`,
  });

  // ---- 3. USD conservation (the C4 invariant) ----
  const blockers: string[] = [];
  if (result.totals.unresolvedDisposals > 0) {
    blockers.push(`${result.totals.unresolvedDisposals} unresolved disposals`);
  }
  if (result.openLots.some((l) => l.costBasisUsd === null)) {
    blockers.push("open lots with unknown basis");
  }
  if (result.totals.withdrawnBasisUsd === null) {
    blockers.push("withdrawn lots with unknown basis");
  }
  if (result.income.some((i) => i.fmvUsd === null)) {
    blockers.push("income with unknown FMV");
  }
  const unknowns = result.flags.filter((f) => f.kind === "REVIEW_UNKNOWN").length;
  if (unknowns > 0) blockers.push(`${unknowns} unclassified transactions`);
  const unpricedDeposits = events.some(
    (e) => e.type === "TRANSFER_IN" && e.usdValue === null &&
      e.tokenOutMint !== null && e.amountOut !== null && e.amountOut > 0,
  );
  if (unpricedDeposits) blockers.push("unpriced deposits");

  if (blockers.length > 0) {
    checks.push({
      name: "USD conservation",
      ok: true,
      skipped: true,
      detail: `not applicable — ${blockers.join(", ")}`,
    });
  } else {
    let depositsUsd = 0;
    let capitalizedFeesUsd = 0;
    for (const e of events) {
      if (e.type === "TRANSFER_IN" && e.usdValue !== null) depositsUsd += e.usdValue;
      if (
        e.type === "SWAP" && e.usdValue !== null &&
        e.tokenOutMint !== null && e.amountOut !== null && e.amountOut > 0
      ) {
        capitalizedFeesUsd += e.feeUsd ?? 0;
      }
    }
    const openBasis = result.openLots.reduce((s, l) => s + (l.costBasisUsd ?? 0), 0);
    const gains = result.totals.shortTermGainUsd + result.totals.longTermGainUsd;
    const expectedGains =
      openBasis - depositsUsd - result.totals.ordinaryIncomeUsd -
      capitalizedFeesUsd + (result.totals.withdrawnBasisUsd ?? 0);
    const delta = gains - expectedGains;
    checks.push({
      name: "USD conservation",
      ok: Math.abs(delta) <= USD_TOLERANCE,
      skipped: false,
      detail:
        Math.abs(delta) <= USD_TOLERANCE
          ? `gains $${gains.toFixed(2)} match money-in/money-out within $${USD_TOLERANCE}`
          : `MISMATCH: gains $${gains.toFixed(2)} vs expected $${expectedGains.toFixed(2)} (Δ $${delta.toFixed(4)}) — possible silent corruption`,
    });
  }

  return { ok: checks.every((c) => c.ok), checks };
}
