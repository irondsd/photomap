import { readdir, stat } from "node:fs/promises";
import { join, relative, dirname, extname, basename } from "node:path";
import { CPUS, kindOf, skipDir, type Kind } from "../config";
import { db, knownFiles, markMissing, nextScanGen, setRootScanned, touchPhoto, upsertPhoto, type PhotoInsert, type RootRow } from "../db";
import { extract } from "./extract";
import { keepManualLocation } from "./locate";

export interface ScanStatus {
  running: boolean;
  root: string | null;
  phase: "idle" | "walking" | "indexing" | "done" | "cancelled" | "error";
  found: number;
  processed: number;
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
  errors: number;
  startedAt: number | null;
  finishedAt: number | null;
  message: string | null;
}

export const status: ScanStatus = {
  running: false, root: null, phase: "idle",
  found: 0, processed: 0, added: 0, updated: 0, unchanged: 0, removed: 0, errors: 0,
  startedAt: null, finishedAt: null, message: null,
};

let cancelRequested = false;
export const cancelScan = () => {
  cancelRequested = true;
};

interface Candidate {
  path: string;
  ext: string;
  kind: Kind;
}

async function walk(root: string, onFound: (n: number) => void): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const stack = [root];
  while (stack.length) {
    if (cancelRequested) break;
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable folder
    }
    for (const ent of entries) {
      // Symlinked folders are skipped to avoid cycles.
      if (ent.isDirectory()) {
        if (!skipDir(ent.name)) stack.push(join(dir, ent.name));
      } else if (ent.isFile()) {
        if (ent.name.startsWith("._")) continue; // macOS resource forks
        const ext = extname(ent.name).slice(1).toLowerCase();
        const kind = kindOf(ext);
        if (kind) out.push({ path: join(dir, ent.name), ext, kind });
      }
    }
    onFound(out.length);
  }
  return out;
}

class Semaphore {
  private queue: (() => void)[] = [];
  constructor(private free: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((r) => this.queue.push(r));
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.free++;
    }
  }
}

async function pool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length && !cancelRequested) await fn(items[i++]!);
  });
  await Promise.all(workers);
}

export type ProgressFn = (s: ScanStatus) => void;

/** Scans a root, or only `subdir` inside it. */
export async function scanRoot(root: RootRow, onProgress?: ProgressFn, subdir: string | null = null): Promise<ScanStatus> {
  if (status.running) throw new Error("A scan is already running");
  cancelRequested = false;
  Object.assign(status, {
    running: true, root: subdir ?? root.path, phase: "walking",
    found: 0, processed: 0, added: 0, updated: 0, unchanged: 0, removed: 0, errors: 0,
    startedAt: Date.now(), finishedAt: null, message: null,
  } satisfies ScanStatus);
  const report = () => onProgress?.(status);

  try {
    const gen = nextScanGen();
    const known = knownFiles(root.id);
    const candidates = await walk(subdir ?? root.path, (n) => {
      status.found = n;
      report();
    });
    status.phase = "indexing";
    report();

    const pendingUpserts: PhotoInsert[] = [];
    const pendingTouches: number[] = [];
    const flush = db.transaction(() => {
      for (const p of pendingUpserts.splice(0)) upsertPhoto(p);
      for (const id of pendingTouches.splice(0)) touchPhoto(id, gen);
    });
    const maybeFlush = () => {
      if (pendingUpserts.length + pendingTouches.length >= 500) flush();
    };

    const videoSlots = new Semaphore(Math.max(2, CPUS));
    let lastReport = 0;

    await pool(candidates, 32, async (c) => {
      try {
        const st = await stat(c.path);
        const mtime = Math.round(st.mtimeMs);
        const prev = known.get(c.path);
        if (prev && prev.size === st.size && prev.mtime === mtime) {
          pendingTouches.push(prev.id);
          status.unchanged++;
        } else {
          const name = basename(c.path);
          const run = () => extract(c.path, c.kind, name, st.mtimeMs);
          let meta = c.kind === "video" ? await videoSlots.run(run) : await run();
          // A location tagged by hand survives the file changing, unless the file now has GPS itself.
          if (prev?.gps_source === "manual" && meta.lat == null && prev.lat != null && prev.lon != null) {
            meta = keepManualLocation(meta, prev.lat, prev.lon);
          }
          if (meta.error) status.errors++;
          pendingUpserts.push({
            root_id: root.id,
            path: c.path,
            rel_dir: relative(root.path, dirname(c.path)),
            name,
            ext: c.ext,
            kind: c.kind,
            size: st.size,
            mtime,
            scan_gen: gen,
            ...meta,
          });
          if (prev) status.updated++;
          else status.added++;
        }
      } catch {
        status.errors++; // vanished or unreadable between walk and stat
      }
      status.processed++;
      maybeFlush();
      const now = performance.now();
      if (now - lastReport > 250) {
        lastReport = now;
        report();
      }
    });
    flush();

    if (cancelRequested) {
      status.phase = "cancelled";
    } else {
      status.removed = markMissing(root.id, gen, subdir ?? undefined);
      if (!subdir) setRootScanned(root.id);
      status.phase = "done";
    }
  } catch (err) {
    status.phase = "error";
    status.message = String((err as Error)?.message ?? err);
  } finally {
    status.running = false;
    status.finishedAt = Date.now();
    report();
  }
  return { ...status };
}
