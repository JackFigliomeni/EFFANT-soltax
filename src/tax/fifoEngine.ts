import type { PricedEvent } from "../pricing/eventPricer.js";

export type Term = "SHORT" | "LONG";

export type FlagKind =
  | "MISSING_HISTORY"
  | "NEEDS_PRICE"
  | "REVIEW_DEPOSIT"
  | "REVIEW_WITHDRAWAL"
  | "REVIEW_UNKNOWN";

export interface OpenLot {
  asset: string;
  amount: number;
  /** Total USD basis for `amount`; null when basis is unknowable. */
  costBasisUsd: number | null;
  acquiredAt: number;
  source: "SWAP" | "INCOME" | "DEPOSIT";
  signature: string;
}

export interface Disposal {
  asset: string;
  amount: number;
  /** Null when the disposal exceeded known lots (MISSING_HISTORY). */
  acquiredAt: number | null;
  disposedAt: number;
  proceedsUsd: number | null;
  costBasisUsd: number | null;
  /** Null whenever proceeds or basis is unknown — never invented. */
  gainLossUsd: number | null;
  term: Term | null;
  signature: string;
  flags: FlagKind[];
}

export interface IncomeEntry {
  asset: string;
  amount: number;
  fmvUsd: number | null;
  timestamp: number;
  signature: string;
  flags: FlagKind[];
}

export interface FlaggedItem {
  kind: FlagKind;
  signature: string;
  timestamp: number;
  asset: string | null;
  detail: string;
}

export interface FifoResult {
  disposals: Disposal[];
  income: IncomeEntry[];
  /** Remaining holdings with their basis, FIFO order. */
  openLots: OpenLot[];
  /** The loud list — everything a human or CPA should look at. */
  flags: FlaggedItem[];
  totals: {
    shortTermGainUsd: number;
    longTermGainUsd: number;
    ordinaryIncomeUsd: number;
    /** Disposals whose gain/loss could not be computed. */
    unresolvedDisposals: number;
    /**
     * USD basis that left the portfolio via TRANSFER_OUT (un-taxed, pending
     * review). Null when any withdrawn lot had unknown basis.
     */
    withdrawnBasisUsd: number | null;
  };
}

/** IRS long-term: held more than one year. */
const LONG_TERM_SECONDS = 365 * 86_400;
const EPSILON = 1e-9;

interface MutableLot extends OpenLot {
  remaining: number;
  /** Basis for the remaining amount (scales down as the lot is consumed). */
  remainingBasisUsd: number | null;
}

/**
 * FIFO lot-tracking engine over priced, classified events.
 *
 * Portfolio view: all owned wallets are one pot, so SELF_TRANSFER never
 * disposes. Crypto-to-crypto is taxable on both sides — a SOL -> token swap
 * disposes SOL lots AND opens a token lot at the swap's USD value (network
 * fee added to the new lot's basis).
 *
 * Honesty rules: a disposal that exceeds known lots emits MISSING_HISTORY
 * with null basis; unpriced values propagate as null gain/loss with
 * NEEDS_PRICE. Basis is never invented.
 *
 * Not modeled (v1): network-fee SOL is not drawn from lots (~5k lamports per
 * tx of drift); TRANSFER_OUT removes lots without realizing gain and is
 * flagged REVIEW_WITHDRAWAL for a human to reclassify (gift, payment, or a
 * wallet that belongs in the owned list).
 */
export class FifoEngine {
  private readonly lots = new Map<string, MutableLot[]>();
  private readonly disposals: Disposal[] = [];
  private readonly income: IncomeEntry[] = [];
  private readonly flags: FlaggedItem[] = [];
  private withdrawnBasisUsd = 0;
  private withdrawnBasisKnown = true;

  process(events: Iterable<PricedEvent>): FifoResult {
    const ordered = [...events].sort(
      (a, b) => a.timestamp - b.timestamp || a.signature.localeCompare(b.signature),
    );

    for (const event of ordered) {
      switch (event.type) {
        case "SWAP":
          this.onSwap(event);
          break;
        case "TRANSFER_IN":
          this.onDeposit(event);
          break;
        case "TRANSFER_OUT":
          this.onWithdrawal(event);
          break;
        case "INCOME":
          this.onIncome(event);
          break;
        case "UNKNOWN":
          this.flag("REVIEW_UNKNOWN", event, event.tokenInMint ?? event.tokenOutMint,
            "unclassified transaction skipped by the tax engine");
          break;
        // SELF_TRANSFER: portfolio-internal movement, lots stay put.
        // SPAM / FAILED / FEE_ONLY: no tax-relevant value.
      }
    }

    let shortTerm = 0;
    let longTerm = 0;
    let unresolved = 0;
    for (const d of this.disposals) {
      if (d.gainLossUsd === null) unresolved += 1;
      else if (d.term === "LONG") longTerm += d.gainLossUsd;
      else shortTerm += d.gainLossUsd;
    }
    const ordinaryIncome = this.income.reduce((s, i) => s + (i.fmvUsd ?? 0), 0);

    const openLots: OpenLot[] = [];
    for (const list of this.lots.values()) {
      for (const lot of list) {
        if (lot.remaining <= EPSILON) continue;
        openLots.push({
          asset: lot.asset,
          amount: lot.remaining,
          costBasisUsd: lot.remainingBasisUsd,
          acquiredAt: lot.acquiredAt,
          source: lot.source,
          signature: lot.signature,
        });
      }
    }

    return {
      disposals: this.disposals,
      income: this.income,
      openLots,
      flags: this.flags,
      totals: {
        shortTermGainUsd: shortTerm,
        longTermGainUsd: longTerm,
        ordinaryIncomeUsd: ordinaryIncome,
        unresolvedDisposals: unresolved,
        withdrawnBasisUsd: this.withdrawnBasisKnown ? this.withdrawnBasisUsd : null,
      },
    };
  }

  private onSwap(event: PricedEvent): void {
    if (event.tokenInMint !== null && event.amountIn !== null && event.amountIn > 0) {
      this.dispose(event, event.tokenInMint, event.amountIn, event.usdValue);
    }
    if (event.tokenOutMint !== null && event.amountOut !== null && event.amountOut > 0) {
      // Network fee is part of what it cost to acquire the new position.
      const basis = event.usdValue === null ? null : event.usdValue + (event.feeUsd ?? 0);
      this.acquire(event, event.tokenOutMint, event.amountOut, basis, "SWAP");
      if (basis === null) {
        this.flag("NEEDS_PRICE", event, event.tokenOutMint,
          "acquired with unknown basis — swap had no priceable leg");
      }
    }
  }

  private onDeposit(event: PricedEvent): void {
    if (event.tokenOutMint === null || event.amountOut === null || event.amountOut <= 0) return;
    // Basis defaults to FMV at receipt; the true basis lives wherever the
    // funds came from (e.g. an exchange), so a human should confirm.
    this.acquire(event, event.tokenOutMint, event.amountOut, event.usdValue, "DEPOSIT");
    this.flag("REVIEW_DEPOSIT", event, event.tokenOutMint,
      event.usdValue === null
        ? "deposit of unpriceable token — basis unknown"
        : `deposit lot created at FMV $${event.usdValue.toFixed(2)} — confirm original basis`);
    if (event.usdValue === null) {
      this.flag("NEEDS_PRICE", event, event.tokenOutMint, "deposit with no priceable value");
    }
  }

  private onWithdrawal(event: PricedEvent): void {
    if (event.tokenInMint === null || event.amountIn === null || event.amountIn <= 0) return;
    // Not treated as a disposal: the assets (and their basis) leave the
    // portfolio un-taxed, pending human reclassification.
    const removed = this.consumeLots(event.tokenInMint, event.amountIn, (_lot, _take, basisPortion) => {
      if (basisPortion === null) this.withdrawnBasisKnown = false;
      else this.withdrawnBasisUsd += basisPortion;
    });
    this.flag("REVIEW_WITHDRAWAL", event, event.tokenInMint,
      `sent ${event.amountIn} to an external address — reclassify as gift/payment/owned wallet`);
    if (removed.missing > EPSILON) {
      this.flag("MISSING_HISTORY", event, event.tokenInMint,
        `withdrew ${event.amountIn} but only ${event.amountIn - removed.missing} had known lots`);
    }
  }

  private onIncome(event: PricedEvent): void {
    if (event.tokenOutMint === null || event.amountOut === null || event.amountOut <= 0) return;
    const flags: FlagKind[] = [];
    if (event.usdValue === null) {
      flags.push("NEEDS_PRICE");
      this.flag("NEEDS_PRICE", event, event.tokenOutMint,
        "income received with no priceable value — FMV required for ordinary income");
    }
    this.income.push({
      asset: event.tokenOutMint,
      amount: event.amountOut,
      fmvUsd: event.usdValue,
      timestamp: event.timestamp,
      signature: event.signature,
      flags,
    });
    // Income creates a lot at FMV — that FMV is both ordinary income now and
    // basis for the eventual disposal.
    this.acquire(event, event.tokenOutMint, event.amountOut, event.usdValue, "INCOME");
  }

  private acquire(
    event: PricedEvent,
    asset: string,
    amount: number,
    costBasisUsd: number | null,
    source: OpenLot["source"],
  ): void {
    const lot: MutableLot = {
      asset,
      amount,
      costBasisUsd,
      acquiredAt: event.timestamp,
      source,
      signature: event.signature,
      remaining: amount,
      remainingBasisUsd: costBasisUsd,
    };
    const list = this.lots.get(asset);
    if (list) list.push(lot);
    else this.lots.set(asset, [lot]);
  }

  private dispose(
    event: PricedEvent,
    asset: string,
    amount: number,
    totalProceedsUsd: number | null,
  ): void {
    const consumed = this.consumeLots(asset, amount, (lot, take, basisPortion) => {
      const proceeds =
        totalProceedsUsd === null ? null : totalProceedsUsd * (take / amount);
      const gain =
        proceeds !== null && basisPortion !== null ? proceeds - basisPortion : null;
      const flags: FlagKind[] = [];
      if (proceeds === null || basisPortion === null) flags.push("NEEDS_PRICE");
      this.disposals.push({
        asset,
        amount: take,
        acquiredAt: lot.acquiredAt,
        disposedAt: event.timestamp,
        proceedsUsd: proceeds,
        costBasisUsd: basisPortion,
        gainLossUsd: gain,
        term: event.timestamp - lot.acquiredAt > LONG_TERM_SECONDS ? "LONG" : "SHORT",
        signature: event.signature,
        flags,
      });
      if (flags.includes("NEEDS_PRICE")) {
        this.flag("NEEDS_PRICE", event, asset,
          proceeds === null ? "disposal with unpriceable proceeds" : "disposal of a lot with unknown basis");
      }
    });

    if (consumed.missing > EPSILON) {
      const missingProceeds =
        totalProceedsUsd === null ? null : totalProceedsUsd * (consumed.missing / amount);
      this.disposals.push({
        asset,
        amount: consumed.missing,
        acquiredAt: null,
        disposedAt: event.timestamp,
        proceedsUsd: missingProceeds,
        costBasisUsd: null,
        gainLossUsd: null,
        term: null,
        signature: event.signature,
        flags: ["MISSING_HISTORY"],
      });
      this.flag("MISSING_HISTORY", event, asset,
        `disposed ${amount} but only ${amount - consumed.missing} had known lots — basis not invented`);
    }
  }

  /**
   * Takes `amount` from the asset's lots FIFO. For each piece taken, calls
   * onTake with the lot, the amount taken, and that piece's USD basis.
   * Returns how much could not be covered by known lots.
   */
  private consumeLots(
    asset: string,
    amount: number,
    onTake?: (lot: MutableLot, take: number, basisPortion: number | null) => void,
  ): { missing: number } {
    let needed = amount;
    const list = this.lots.get(asset) ?? [];
    for (const lot of list) {
      if (needed <= EPSILON) break;
      if (lot.remaining <= EPSILON) continue;
      const take = Math.min(lot.remaining, needed);
      const basisPortion =
        lot.remainingBasisUsd === null
          ? null
          : lot.remainingBasisUsd * (take / lot.remaining);
      if (lot.remainingBasisUsd !== null && basisPortion !== null) {
        lot.remainingBasisUsd -= basisPortion;
      }
      lot.remaining -= take;
      needed -= take;
      onTake?.(lot, take, basisPortion);
    }
    return { missing: Math.max(needed, 0) };
  }

  private flag(
    kind: FlagKind,
    event: PricedEvent,
    asset: string | null,
    detail: string,
  ): void {
    this.flags.push({
      kind,
      signature: event.signature,
      timestamp: event.timestamp,
      asset,
      detail,
    });
  }
}
