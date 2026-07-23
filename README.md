# SOLTAX

[![CI](https://github.com/JackFigliomeni/EFFANT-soltax/actions/workflows/ci.yml/badge.svg)](https://github.com/JackFigliomeni/EFFANT-soltax/actions/workflows/ci.yml)

A Solana-only tax engine. It fetches a wallet's complete on-chain history,
classifies every transaction (pump.fun, Jupiter routes, Raydium, OKX, DFlow,
Moonshot, spam, staking, and more), prices everything in USD at minute
granularity, runs FIFO cost-basis math with a built-in audit, and exports
filing-ready reports — Form 8949 CSVs, a TurboTax import file, and a full
ledger for your accountant.

Built for wallets the mainstream tools choke on: bonding-curve buys,
multi-hop aggregator swaps, dead memecoins with no price feed, and histories
that are half airdrop spam.

## The honesty rules

Tax software is only useful if you can trust it, so the engine refuses to
guess:

- **Basis is never invented.** A disposal that exceeds known lots is flagged
  `MISSING_HISTORY`, not papered over.
- **Prices are never guessed.** An event with no priceable leg is flagged
  `NEEDS_PRICE`. Illiquid tokens are priced from the SOL or stablecoin side
  of your own trades — the one place their price is actually recorded.
- **Unknowns stay unknown.** Unrecognized transactions go to a worklist
  (`soltax unknowns`) with Solscan links instead of being mislabeled.
- **The math audits itself.** Money in minus money out must equal reported
  gains (within a cent) or `soltax report` refuses to export.
- **Nothing is silently dropped.** Every excluded or flagged item lands in
  `needs-review.csv` with a reason and a Solscan link.

## Quickstart

Requires Node 20+ and a free [Helius](https://dashboard.helius.dev) API key.

```bash
git clone https://github.com/JackFigliomeni/EFFANT-soltax.git
cd EFFANT-soltax
npm ci
cp .env.example .env   # add HELIUS_API_KEY=<your key>
npm run build
```

Then the whole pipeline in one shot:

```bash
node dist/cli.js run <wallet-address> --year 2025
```

Or `npm link` once and use `soltax` directly.

## Commands

| Command | What it does |
|---|---|
| `soltax run <wallet>... [--year YYYY]` | Fetch + report + benchmark in one shot |
| `soltax analyze <wallet>` | Fetch full history into the local cache (resumable, never refetches) |
| `soltax events <wallet>... [--json] [--include-spam]` | Chronological classified events with USD values |
| `soltax gains <wallet>...` | FIFO gains/income/flags summary with the math audit |
| `soltax report <wallet>... [--year YYYY] [--out dir]` | Write 8949 CSVs, TurboTax CSV, ledger, needs-review, summary |
| `soltax unknowns <wallet>` | Unclassified transactions by program frequency — the worklist |
| `soltax benchmark <wallet>...` | Classification-rate stats across wallets |
| `soltax test-fixtures` | Run the classifier against the fixture suite |

Passing multiple wallets to `run`/`events`/`gains`/`report` treats them as one
portfolio: transfers between your own wallets become non-taxable
`SELF_TRANSFER`s and lots move freely between them. You can also set
`SOLTAX_OWNED_WALLETS` in `.env` (comma-separated).

## How it works

```
Helius API ──► disk cache (JSONL, signature-keyed, resumable)
                  │
                  ▼
             classifier ──► normalized events   { type, tokenIn/Out, amounts, fee }
                  │            SWAP · TRANSFER_IN/OUT · SELF_TRANSFER · INCOME
                  │            FEE_ONLY · SPAM · FAILED · UNKNOWN
                  ▼
              pricer ──► USD values             stable leg > SOL leg > NEEDS_PRICE
                  │                             (SOL/USD: Binance 1-minute klines,
                  │                              binance.us and CoinGecko fallbacks)
                  ▼
            FIFO engine ──► lots, disposals, income, flags
                  │            + conservation audit (money in = money out ± gains)
                  ▼
             reports ──► 8949 · TurboTax · ledger · needs-review · summary
```

Classification works on net asset flows per transaction, which is why a
Jupiter route through three pools collapses into the one swap you actually
made, and why wash legs cancel to zero. Swap venues are detected by program
id (Jupiter, OKX router, DFlow, Moonshot, pump.fun, PumpSwap, Raydium
AMM/CLMM) with the indexer's own swap tag as a fallback for routers we don't
match yet.

## The fixtures loop

Correctness is enforced by fixtures: real transaction JSONs paired with
hand-written expected classifications, run in CI on every push
(`fixtures/`, currently 28 — 8 captured from mainnet). The improvement loop:

1. `soltax unknowns <wallet>` shows what didn't classify
2. Save the transaction as `fixtures/<category>/<name>.tx.json`
3. Write `<name>.expected.json` with the correct classification
4. Extend the classifier until `soltax test-fixtures` passes 100%

## Development

```bash
npx vitest        # watch mode
npm test          # full suite
npx tsc --noEmit  # typecheck (strict mode)
```

The Helius client, price providers, and pricer all accept injected `fetch`
implementations, so the entire test suite runs offline.

## Disclaimer

This is software, not tax advice. It flags what it isn't sure about — review
flagged items with a CPA before filing.
