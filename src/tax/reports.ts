import { NATIVE_SOL_MINT } from "../classifier/programs.js";
import type { PricedEvent } from "../pricing/eventPricer.js";
import type { AuditReport } from "./audit.js";
import type { Disposal, FifoResult } from "./fifoEngine.js";

export interface ReportOptions {
  wallet: string;
  /** Calendar (UTC) tax year; omit for all years. */
  year?: number;
  audit: AuditReport;
}

export interface ReportBundle {
  /** filename -> CSV/text content. */
  files: Map<string, string>;
  summaryText: string;
}

export function csvField(value: string | number | null): string {
  if (value === null) return "";
  const s = typeof value === "number" ? String(value) : value;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvLine(...fields: Array<string | number | null>): string {
  return fields.map(csvField).join(",");
}

function mmddyyyy(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getUTCFullYear()}`;
}

function isoDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace("T", " ").slice(0, 19);
}

function assetLabel(mint: string): string {
  return mint === NATIVE_SOL_MINT ? "SOL" : `${mint.slice(0, 6)}…${mint.slice(-4)}`;
}

function amountStr(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 9, useGrouping: false });
}

function usd2(n: number): string {
  return n.toFixed(2);
}

function solscan(signature: string): string {
  return `https://solscan.io/tx/${signature}`;
}

/** "1234.5 SOL" — the 8949 property description. */
function describe(d: Disposal): string {
  return `${amountStr(d.amount)} ${assetLabel(d.asset)}`;
}

function build8949Section(rows: Disposal[]): string {
  const lines = [
    csvLine(
      "Description of property",
      "Date acquired",
      "Date sold or disposed of",
      "Proceeds (USD)",
      "Cost or other basis (USD)",
      "Gain or (loss) (USD)",
      "Transaction signature",
    ),
  ];
  let proceeds = 0;
  let basis = 0;
  let gain = 0;
  for (const d of rows) {
    // Sum the rounded, printed values so the TOTAL row reconciles exactly
    // with the rows above it (what actually gets filed).
    proceeds += Number(usd2(d.proceedsUsd!));
    basis += Number(usd2(d.costBasisUsd!));
    gain += Number(usd2(d.gainLossUsd!));
    lines.push(
      csvLine(
        describe(d),
        d.acquiredAt === null ? "" : mmddyyyy(d.acquiredAt),
        mmddyyyy(d.disposedAt),
        usd2(d.proceedsUsd!),
        usd2(d.costBasisUsd!),
        usd2(d.gainLossUsd!),
        d.signature,
      ),
    );
  }
  lines.push(csvLine("TOTAL", "", "", usd2(proceeds), usd2(basis), usd2(gain), ""));
  return lines.join("\n") + "\n";
}

function buildTurboTax(rows: Disposal[]): string {
  // The gain/loss import format TurboTax accepts from crypto aggregators.
  const lines = [csvLine("Currency Name", "Purchase Date", "Cost Basis", "Date Sold", "Proceeds")];
  for (const d of rows) {
    lines.push(
      csvLine(
        describe(d),
        d.acquiredAt === null ? "" : mmddyyyy(d.acquiredAt),
        usd2(d.costBasisUsd!),
        mmddyyyy(d.disposedAt),
        usd2(d.proceedsUsd!),
      ),
    );
  }
  return lines.join("\n") + "\n";
}

function buildLedger(events: PricedEvent[]): string {
  const lines = [
    csvLine(
      "Date (UTC)",
      "Type",
      "Protocol",
      "Asset sent",
      "Amount sent",
      "Asset received",
      "Amount received",
      "USD value",
      "Price source",
      "SOL/USD",
      "Fee (lamports)",
      "Fee (USD)",
      "Needs price",
      "Signature",
      "Solscan",
    ),
  ];
  for (const e of events) {
    lines.push(
      csvLine(
        isoDate(e.timestamp),
        e.type,
        e.protocol,
        e.tokenInMint,
        e.amountIn === null ? null : amountStr(e.amountIn),
        e.tokenOutMint,
        e.amountOut === null ? null : amountStr(e.amountOut),
        e.usdValue === null ? null : usd2(e.usdValue),
        e.priceSource,
        e.solUsd === null ? null : e.solUsd.toFixed(4),
        e.feeLamports,
        e.feeUsd === null ? null : e.feeUsd.toFixed(6),
        e.needsPrice ? "YES" : "",
        e.signature,
        solscan(e.signature),
      ),
    );
  }
  return lines.join("\n") + "\n";
}

function buildNeedsReview(result: FifoResult, unresolved: Disposal[], inYear: (ts: number) => boolean): string {
  const lines = [csvLine("Date (UTC)", "Kind", "Asset", "Detail", "Signature", "Solscan")];
  for (const f of result.flags) {
    if (!inYear(f.timestamp)) continue;
    lines.push(
      csvLine(isoDate(f.timestamp), f.kind, f.asset, f.detail, f.signature, solscan(f.signature)),
    );
  }
  for (const d of unresolved) {
    lines.push(
      csvLine(
        isoDate(d.disposedAt),
        "UNRESOLVED_DISPOSAL",
        d.asset,
        `disposal of ${amountStr(d.amount)} excluded from Form 8949 — ${d.flags.join("+") || "missing value"}`,
        d.signature,
        solscan(d.signature),
      ),
    );
  }
  return lines.join("\n") + "\n";
}

/**
 * Builds the C5 export bundle from priced events and the FIFO result.
 * Only fully-resolved disposals reach the 8949/TurboTax files; everything
 * excluded lands in needs-review.csv — losses are never silently dropped
 * and basis is never invented.
 */
export function buildReports(
  events: PricedEvent[],
  result: FifoResult,
  options: ReportOptions,
): ReportBundle {
  const year = options.year ?? null;
  const inYear = (ts: number): boolean =>
    year === null || new Date(ts * 1000).getUTCFullYear() === year;
  const prefix = year === null ? "all-years" : String(year);

  const disposals = result.disposals.filter((d) => inYear(d.disposedAt));
  const resolved = disposals.filter((d) => d.gainLossUsd !== null);
  const unresolved = disposals.filter((d) => d.gainLossUsd === null);
  const shortRows = resolved.filter((d) => d.term !== "LONG");
  const longRows = resolved.filter((d) => d.term === "LONG");
  const income = result.income.filter((i) => inYear(i.timestamp));
  const yearEvents = events.filter((e) => inYear(e.timestamp));

  const shortGain = shortRows.reduce((s, d) => s + d.gainLossUsd!, 0);
  const longGain = longRows.reduce((s, d) => s + d.gainLossUsd!, 0);
  const ordinaryIncome = income.reduce((s, i) => s + (i.fmvUsd ?? 0), 0);
  const feesUsd = yearEvents.reduce((s, e) => s + (e.feeUsd ?? 0), 0);
  const yearFlags = result.flags.filter((f) => inYear(f.timestamp));
  const flagKinds = new Map<string, number>();
  for (const f of yearFlags) flagKinds.set(f.kind, (flagKinds.get(f.kind) ?? 0) + 1);

  const summaryLines = [
    `SOLTAX tax report — wallet ${options.wallet}`,
    `Tax year: ${year ?? "all years"} (UTC calendar) · generated ${new Date().toISOString().slice(0, 10)}`,
    ``,
    `This is software output, not tax advice. Review flagged items with a CPA.`,
    ``,
    `CAPITAL GAINS (FIFO)`,
    `  Net short-term gain/loss:  $${shortGain.toFixed(2)}  (${shortRows.length} disposals)`,
    `  Net long-term gain/loss:   $${longGain.toFixed(2)}  (${longRows.length} disposals)`,
    `  Excluded from Form 8949:   ${unresolved.length} unresolved disposals -> needs-review.csv`,
    ``,
    `ORDINARY INCOME`,
    `  $${ordinaryIncome.toFixed(2)} across ${income.length} income events`,
    ``,
    `NETWORK FEES`,
    `  $${feesUsd.toFixed(2)} total (capitalized into basis where applicable)`,
    ``,
    `FLAGGED FOR REVIEW: ${yearFlags.length + unresolved.length} items`,
    ...[...flagKinds.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([kind, count]) => `  ${kind.padEnd(20)} ${count}`),
    ``,
    `MATH AUDIT: ${options.audit.ok ? "PASS" : "FAIL"}`,
    ...options.audit.checks.map(
      (c) => `  ${c.skipped ? "-" : c.ok ? "+" : "x"} ${c.name}: ${c.detail}`,
    ),
  ];
  const summaryText = summaryLines.join("\n") + "\n";

  const files = new Map<string, string>([
    [`${prefix}-8949-short-term.csv`, build8949Section(shortRows)],
    [`${prefix}-8949-long-term.csv`, build8949Section(longRows)],
    [`${prefix}-turbotax.csv`, buildTurboTax(resolved)],
    [`${prefix}-ledger.csv`, buildLedger(yearEvents)],
    [`${prefix}-needs-review.csv`, buildNeedsReview(result, unresolved, inYear)],
    [`${prefix}-summary.txt`, summaryText],
  ]);

  return { files, summaryText };
}
