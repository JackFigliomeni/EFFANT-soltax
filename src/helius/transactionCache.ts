import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import type { HeliusParsedTransaction } from "./types.js";

export interface CacheMeta {
  /** Most recent signature we have fetched (head of the wallet's history). */
  newestSignature?: string;
  /** Oldest signature we have fetched — pagination resumes from here. */
  oldestSignature?: string;
  /** True once pagination has reached the end of the wallet's history. */
  complete: boolean;
  /** Number of transactions in the JSONL file. */
  total: number;
}

const EMPTY_META: CacheMeta = { complete: false, total: 0 };

/**
 * Append-only JSONL cache of parsed transactions for a single wallet.
 *
 * Layout inside the cache directory:
 *   <wallet>.jsonl      one parsed transaction per line
 *   <wallet>.meta.json  pagination cursor + completeness flag
 *
 * Only signatures are held in memory (a Set), never the transactions
 * themselves, so wallets with 50k+ transactions stay cheap: reads stream
 * line-by-line and writes append to the JSONL file as pages arrive.
 */
export class TransactionCache {
  private constructor(
    private readonly signatures: Set<string>,
    private readonly stream: WriteStream,
    private meta: CacheMeta,
    readonly jsonlPath: string,
    private readonly metaPath: string,
  ) {}

  static async open(cacheDir: string, wallet: string): Promise<TransactionCache> {
    await mkdir(cacheDir, { recursive: true });
    const jsonlPath = join(cacheDir, `${wallet}.jsonl`);
    const metaPath = join(cacheDir, `${wallet}.meta.json`);

    const signatures = new Set<string>();
    try {
      const lines = createInterface({
        input: createReadStream(jsonlPath, "utf8"),
        crlfDelay: Infinity,
      });
      for await (const line of lines) {
        if (!line.trim()) continue;
        const tx = JSON.parse(line) as HeliusParsedTransaction;
        signatures.add(tx.signature);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    let meta: CacheMeta = { ...EMPTY_META };
    try {
      meta = JSON.parse(await readFile(metaPath, "utf8")) as CacheMeta;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // The JSONL file is the source of truth; heal the count if meta drifted
    // (e.g. the process died between an append and a meta write).
    meta.total = signatures.size;

    const stream = createWriteStream(jsonlPath, { flags: "a", encoding: "utf8" });
    return new TransactionCache(signatures, stream, meta, jsonlPath, metaPath);
  }

  has(signature: string): boolean {
    return this.signatures.has(signature);
  }

  get size(): number {
    return this.signatures.size;
  }

  getMeta(): CacheMeta {
    return { ...this.meta };
  }

  /** Appends a transaction, waiting for backpressure if the stream is full. */
  async append(tx: HeliusParsedTransaction): Promise<void> {
    if (this.signatures.has(tx.signature)) return;
    this.signatures.add(tx.signature);
    this.meta.total = this.signatures.size;
    const ok = this.stream.write(JSON.stringify(tx) + "\n");
    if (!ok) {
      await new Promise<void>((resolve) => this.stream.once("drain", resolve));
    }
  }

  /** Persists the pagination cursor; called after every page so interrupted runs resume. */
  async updateMeta(patch: Partial<CacheMeta>): Promise<void> {
    this.meta = { ...this.meta, ...patch, total: this.signatures.size };
    const tmp = this.metaPath + ".tmp";
    await writeFile(tmp, JSON.stringify(this.meta, null, 2), "utf8");
    await rename(tmp, this.metaPath);
  }

  /** Streams every cached transaction without loading the file into memory. */
  async *readAll(): AsyncGenerator<HeliusParsedTransaction> {
    let lines: ReturnType<typeof createInterface>;
    try {
      lines = createInterface({
        input: createReadStream(this.jsonlPath, "utf8"),
        crlfDelay: Infinity,
      });
    } catch {
      return;
    }
    for await (const line of lines) {
      if (!line.trim()) continue;
      yield JSON.parse(line) as HeliusParsedTransaction;
    }
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }
}
