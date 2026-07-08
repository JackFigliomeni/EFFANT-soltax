import type { HeliusParsedTransaction } from "../helius/types.js";
import {
  JUPITER_V6_PROGRAM,
  LAMPORTS_PER_SOL,
  NATIVE_SOL_MINT,
  PUMPFUN_PROGRAM,
  PUMPSWAP_PROGRAM,
  RAYDIUM_AMM_PROGRAM,
  RAYDIUM_CLMM_PROGRAM,
  STAKE_PROGRAM,
} from "./programs.js";
import type {
  ClassifierContext,
  ClassifyAllOptions,
  EventType,
  NormalizedEvent,
  Protocol,
} from "./types.js";

const DEFAULT_DUST_THRESHOLD_LAMPORTS = 100_000;
/** A token airdropped to this many distinct recipients in one tx is spam. */
const MASS_AIRDROP_MIN_RECIPIENTS = 3;

interface MintFlow {
  in: number;
  out: number;
}

/** Everything the wallet gave and got in one transaction, netted per mint. */
interface NetFlows {
  /** mint → net amount (positive = wallet received). Zero-net mints (Jupiter intermediate hops) are dropped. */
  gave: Array<{ mint: string; amount: number }>;
  got: Array<{ mint: string; amount: number }>;
  /** Wallets that sent to us / that we sent to. */
  senders: Set<string>;
  recipients: Set<string>;
  /** Net native lamports (excludes the tx fee, which is not a transfer). */
  nativeLamports: number;
  /** Distinct recipients of token transfers across the whole tx (spam signal). */
  tokenRecipientCount: number;
}

function collectProgramIds(tx: HeliusParsedTransaction): Set<string> {
  const ids = new Set<string>();
  for (const ix of tx.instructions ?? []) {
    ids.add(ix.programId);
    for (const inner of ix.innerInstructions ?? []) {
      ids.add(inner.programId);
    }
  }
  return ids;
}

/** Jupiter first: a routed swap contains the hop AMMs as inner instructions. */
function detectProtocol(programIds: Set<string>): Protocol | null {
  if (programIds.has(JUPITER_V6_PROGRAM)) return "JUPITER";
  if (programIds.has(PUMPFUN_PROGRAM)) return "PUMPFUN";
  if (programIds.has(PUMPSWAP_PROGRAM)) return "PUMPSWAP";
  if (programIds.has(RAYDIUM_CLMM_PROGRAM)) return "RAYDIUM_CLMM";
  if (programIds.has(RAYDIUM_AMM_PROGRAM)) return "RAYDIUM_AMM";
  return null;
}

function computeNetFlows(tx: HeliusParsedTransaction, wallet: string): NetFlows {
  const flows = new Map<string, MintFlow>();
  const senders = new Set<string>();
  const recipients = new Set<string>();
  const tokenRecipients = new Set<string>();
  let nativeInLamports = 0;
  let nativeOutLamports = 0;

  const flow = (mint: string): MintFlow => {
    let f = flows.get(mint);
    if (!f) {
      f = { in: 0, out: 0 };
      flows.set(mint, f);
    }
    return f;
  };

  for (const t of tx.nativeTransfers ?? []) {
    if (t.fromUserAccount === wallet && t.toUserAccount !== wallet) {
      nativeOutLamports += t.amount;
      recipients.add(t.toUserAccount);
    }
    if (t.toUserAccount === wallet && t.fromUserAccount !== wallet) {
      nativeInLamports += t.amount;
      senders.add(t.fromUserAccount);
    }
  }

  for (const t of tx.tokenTransfers ?? []) {
    tokenRecipients.add(t.toUserAccount);
    if (t.fromUserAccount === wallet && t.toUserAccount !== wallet) {
      flow(t.mint).out += t.tokenAmount;
      recipients.add(t.toUserAccount);
    }
    if (t.toUserAccount === wallet && t.fromUserAccount !== wallet) {
      flow(t.mint).in += t.tokenAmount;
      senders.add(t.fromUserAccount);
    }
  }

  const nativeLamports = nativeInLamports - nativeOutLamports;
  if (nativeLamports !== 0) {
    const f = flow(NATIVE_SOL_MINT);
    if (nativeLamports > 0) f.in += nativeLamports / LAMPORTS_PER_SOL;
    else f.out += -nativeLamports / LAMPORTS_PER_SOL;
  }

  const gave: Array<{ mint: string; amount: number }> = [];
  const got: Array<{ mint: string; amount: number }> = [];
  for (const [mint, f] of flows) {
    const net = f.in - f.out;
    // Intermediate route hops pass through the wallet and net to ~zero.
    const epsilon = Math.max(f.in, f.out) * 1e-9;
    if (Math.abs(net) <= epsilon) continue;
    if (net > 0) got.push({ mint, amount: net });
    else gave.push({ mint, amount: -net });
  }
  gave.sort((a, b) => b.amount - a.amount);
  got.sort((a, b) => b.amount - a.amount);

  return {
    gave,
    got,
    senders,
    recipients,
    nativeLamports,
    tokenRecipientCount: tokenRecipients.size,
  };
}

function isSubsetOf(set: Set<string>, superset: Set<string>): boolean {
  for (const item of set) {
    if (!superset.has(item)) return false;
  }
  return true;
}

export function classifyTransaction(
  tx: HeliusParsedTransaction,
  ctx: ClassifierContext,
): NormalizedEvent {
  const owned = new Set([ctx.wallet, ...(ctx.ownedWallets ?? [])]);
  const dustThreshold = ctx.dustThresholdLamports ?? DEFAULT_DUST_THRESHOLD_LAMPORTS;
  const feeLamports = owned.has(tx.feePayer) ? tx.fee : 0;

  const event = (
    type: EventType,
    fields: Partial<Pick<
      NormalizedEvent,
      "protocol" | "tokenInMint" | "amountIn" | "tokenOutMint" | "amountOut"
    >> = {},
  ): NormalizedEvent => ({
    signature: tx.signature,
    timestamp: tx.timestamp,
    type,
    protocol: fields.protocol ?? null,
    tokenInMint: fields.tokenInMint ?? null,
    amountIn: fields.amountIn ?? null,
    tokenOutMint: fields.tokenOutMint ?? null,
    amountOut: fields.amountOut ?? null,
    feeLamports,
  });

  if (tx.transactionError != null) {
    return event("FAILED");
  }

  const flows = computeNetFlows(tx, ctx.wallet);
  const programIds = collectProgramIds(tx);
  const protocol = detectProtocol(programIds);
  const primaryGave = flows.gave[0];
  const primaryGot = flows.got[0];

  // Gave and got something: a swap. A known protocol tags it; an unknown
  // program with two-way flows goes to the UNKNOWN worklist instead of being
  // silently mislabeled.
  if (primaryGave && primaryGot) {
    return event(protocol ? "SWAP" : "UNKNOWN", {
      protocol,
      tokenInMint: primaryGave.mint,
      amountIn: primaryGave.amount,
      tokenOutMint: primaryGot.mint,
      amountOut: primaryGot.amount,
    });
  }

  // Only gave: outgoing transfer (or movement between owned wallets).
  if (primaryGave) {
    const selfOnly =
      flows.recipients.size > 0 && isSubsetOf(flows.recipients, owned);
    return event(selfOnly ? "SELF_TRANSFER" : "TRANSFER_OUT", {
      tokenInMint: primaryGave.mint,
      amountIn: primaryGave.amount,
    });
  }

  // Only got: deposit, income, or spam.
  if (primaryGot) {
    const received = {
      tokenOutMint: primaryGot.mint,
      amountOut: primaryGot.amount,
    };

    if (flows.senders.size > 0 && isSubsetOf(flows.senders, owned)) {
      return event("SELF_TRANSFER", received);
    }

    // Stake withdrawals are rewards leaving the stake account for the wallet.
    if (programIds.has(STAKE_PROGRAM) && primaryGot.mint === NATIVE_SOL_MINT) {
      return event("INCOME", received);
    }

    // The user signed (paid the fee for) a receive-only transaction: they
    // actively claimed something — an airdrop claim, reward distribution, etc.
    if (owned.has(tx.feePayer)) {
      return event("INCOME", received);
    }

    // Dust attack: unsolicited, tiny native deposit.
    if (
      primaryGot.mint === NATIVE_SOL_MINT &&
      flows.nativeLamports > 0 &&
      flows.nativeLamports <= dustThreshold
    ) {
      return event("SPAM", received);
    }

    // Mass airdrop: one tx spraying tokens at many recipients, none of them
    // the fee payer. Single-recipient deposits (e.g. exchange withdrawals to
    // this wallet) stay TRANSFER_IN.
    if (
      primaryGot.mint !== NATIVE_SOL_MINT &&
      flows.tokenRecipientCount >= MASS_AIRDROP_MIN_RECIPIENTS
    ) {
      return event("SPAM", received);
    }

    return event("TRANSFER_IN", received);
  }

  return event("UNKNOWN");
}

/**
 * Classifies a batch. SPAM and FAILED events are excluded from the result
 * (they are not tax events) unless includeSpam is set.
 */
export function classifyTransactions(
  txs: Iterable<HeliusParsedTransaction>,
  options: ClassifyAllOptions,
): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  for (const tx of txs) {
    const e = classifyTransaction(tx, options);
    if (!options.includeSpam && (e.type === "SPAM" || e.type === "FAILED")) continue;
    events.push(e);
  }
  return events;
}

/** Streaming variant for cache-backed iteration over large wallets. */
export async function* classifyStream(
  txs: AsyncIterable<HeliusParsedTransaction>,
  options: ClassifyAllOptions,
): AsyncGenerator<NormalizedEvent> {
  for await (const tx of txs) {
    const e = classifyTransaction(tx, options);
    if (!options.includeSpam && (e.type === "SPAM" || e.type === "FAILED")) continue;
    yield e;
  }
}
