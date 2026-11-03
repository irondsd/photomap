import { ServerError } from "./api";
import { CHECK_BATCH, type ManifestItem } from "./protocol";

export type SyncDeps = {
  /** A page of the library from the sync start date, oldest first. */
  listPage(offset: number, limit: number): Promise<{ items: ManifestItem[]; count: number }>;
  /** Ids of the given items the server doesn't have. */
  check(items: ManifestItem[]): Promise<string[]>;
  upload(item: ManifestItem, onBytes: (sent: number, total: number) => void, signal: AbortSignal): Promise<void>;
};

export type SyncProgress =
  | { phase: "checking"; scanned: number; missing: number }
  | {
      phase: "uploading";
      done: number;
      total: number;
      failed: number;
      current: string;
      bytesSent: number;
      bytesTotal: number;
    };

export type SyncResult = {
  scanned: number;
  /** Already on the server before this run. */
  present: number;
  uploaded: number;
  failed: { filename: string; error: string }[];
  /** Why the run ended early, if it did. */
  stopped?: string;
  cancelled: boolean;
};

/** Network failures in a row after which the run gives up rather than failing every file. */
export const MAX_CONSECUTIVE_FAILURES = 3;
/** Attempts per file when the request never reached the server. */
export const UPLOAD_ATTEMPTS = 2;

/**
 * Lists everything from the start date, asks the server which ones it lacks, then uploads
 * those one at a time. The server is the record of what's synced, so a run that stops halfway
 * just picks up the rest next time.
 */
export async function runSync(
  deps: SyncDeps,
  { onProgress, signal }: { onProgress: (p: SyncProgress) => void; signal: AbortSignal },
): Promise<SyncResult> {
  const result: SyncResult = { scanned: 0, present: 0, uploaded: 0, failed: [], cancelled: false };
  const missing: ManifestItem[] = [];

  try {
    for (let offset = 0; ; offset += CHECK_BATCH) {
      if (signal.aborted) return { ...result, cancelled: true };
      const page = await deps.listPage(offset, CHECK_BATCH);
      if (page.items.length > 0) {
        const lacking = new Set(await deps.check(page.items));
        for (const item of page.items) if (lacking.has(item.id)) missing.push(item);
      }
      result.scanned += page.items.length;
      result.present = result.scanned - missing.length;
      onProgress({ phase: "checking", scanned: result.scanned, missing: missing.length });
      if (page.count < CHECK_BATCH) break;
    }
  } catch (e) {
    return { ...result, stopped: describe(e) };
  }

  let consecutive = 0;
  for (const [i, item] of missing.entries()) {
    if (signal.aborted) return { ...result, cancelled: true };
    const report = (bytesSent: number, bytesTotal: number) =>
      onProgress({
        phase: "uploading",
        done: i,
        total: missing.length,
        failed: result.failed.length,
        current: item.filename,
        bytesSent,
        bytesTotal,
      });
    report(0, 0);
    try {
      await uploadWithRetry(deps, item, report, signal);
      result.uploaded++;
      consecutive = 0;
    } catch (e) {
      if (signal.aborted) return { ...result, cancelled: true };
      if (e instanceof ServerError && e.status === 401) return { ...result, stopped: e.message };
      result.failed.push({ filename: item.filename, error: describe(e) });
      // A server that rejects one file is still there; only lost connections count toward giving up.
      consecutive = e instanceof ServerError ? 0 : consecutive + 1;
      if (consecutive >= MAX_CONSECUTIVE_FAILURES) {
        return { ...result, stopped: `Lost the connection to Photomap: ${describe(e)}` };
      }
    }
  }
  onProgress({
    phase: "uploading",
    done: missing.length,
    total: missing.length,
    failed: result.failed.length,
    current: "",
    bytesSent: 0,
    bytesTotal: 0,
  });
  return result;
}

async function uploadWithRetry(
  deps: SyncDeps,
  item: ManifestItem,
  onBytes: (sent: number, total: number) => void,
  signal: AbortSignal,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await deps.upload(item, onBytes, signal);
    } catch (e) {
      if (signal.aborted || e instanceof ServerError || attempt >= UPLOAD_ATTEMPTS) throw e;
    }
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
