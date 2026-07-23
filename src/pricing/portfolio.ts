import type { EventType } from "../classifier/types.js";
import type { PricedEvent } from "./eventPricer.js";

/**
 * When one transaction is seen from multiple owned-wallet perspectives
 * (e.g. a transfer between two of the user's wallets exists in both caches),
 * keep the most informative classification.
 */
const TYPE_PRIORITY: Record<EventType, number> = {
  SWAP: 0,
  INCOME: 1,
  TRANSFER_IN: 2,
  TRANSFER_OUT: 3,
  SELF_TRANSFER: 4,
  UNKNOWN: 5,
  FEE_ONLY: 6,
  SPAM: 7,
  FAILED: 8,
};

/**
 * Merges per-wallet event streams into one portfolio stream: exactly one
 * event per transaction signature, chronological. Prevents double-counting
 * of fees and keeps inter-wallet transfers as single SELF_TRANSFER events.
 */
export function mergePortfolioEvents(events: PricedEvent[]): PricedEvent[] {
  const bySignature = new Map<string, PricedEvent>();
  for (const event of events) {
    const existing = bySignature.get(event.signature);
    if (!existing || TYPE_PRIORITY[event.type] < TYPE_PRIORITY[existing.type]) {
      bySignature.set(event.signature, event);
    }
  }
  return [...bySignature.values()].sort(
    (a, b) => a.timestamp - b.timestamp || a.signature.localeCompare(b.signature),
  );
}
