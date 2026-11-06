import { existsSync, statSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { findPairs, type FileEntry, type PairStats } from "./pairs";

/**
 * Pulls just the training photos out of Google Takeout zips: the edits and their originals,
 * nothing else (no videos, no JSON, no unedited photos). A photo's edit and original can land
 * in different archives, so every archive is listed before any is extracted.
 *
 * Only the "Photos from <year>" folders are read: they hold every photo, and album folders
 * repeat them. Uses `bsdtar` (macOS's built-in libarchive), which reads zip names as UTF-8 and
 * seeks straight to each entry, where `unzip` garbles non-ASCII names.
 */

export interface ZipEntry extends FileEntry {
  zip: string;
}

const LINE = /^\S+\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\w{3}\s+\d+\s+[\d:]+\s+(.*)$/;
const YEAR_DIR = /(^|\/)Photos from \d{4}\//;

export function parseListing(text: string, zip: string): ZipEntry[] {
  const out: ZipEntry[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(LINE);
    if (m && !m[2]!.endsWith("/")) out.push({ zip, size: Number(m[1]), path: m[2]! });
  }
  return out;
}

async function sh(cmd: string[]): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  if ((await p.exited) !== 0) throw new Error(`${cmd[0]}: ${err.trim() || "failed"}`);
  return out;
}

/** bsdtar -T reads patterns; escape the characters that would make a name one. */
const literal = (name: string) => name.replace(/[\\*?[]/g, (c) => `\\${c}`);

export async function extractTakeout(
  zips: string[],
  outDir: string,
  log: (s: string) => void,
  dryRun = false,
): Promise<{ stats: PairStats; extracted: number; bytes: number }> {
  const entries: ZipEntry[] = [];
  for (const zip of zips) {
    const list = parseListing(await sh(["bsdtar", "-tvf", zip]), zip);
    entries.push(...list.filter((e) => YEAR_DIR.test(e.path)));
    log(`  ${basename(zip)}: ${list.length} entries`);
  }
  const { pairs, stats } = findPairs(entries);
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const wanted = pairs.flatMap((p) => [p.edited, ...(p.original ? [p.original] : [])]).map((p) => byPath.get(p)!);
  // Already extracted at full size: an interrupted run doesn't start over.
  const todo = wanted.filter((e) => {
    const f = join(outDir, e.path);
    return !existsSync(f) || statSync(f).size !== e.size;
  });
  const bytes = todo.reduce((s, e) => s + e.size, 0);
  log(
    `${stats.edited} edits, ${stats.withOriginal} with their original: ${wanted.length} files, ` +
      `${todo.length} to extract (${(bytes / 1e9).toFixed(1)} GB)`,
  );

  if (dryRun) return { stats, extracted: 0, bytes };
  await mkdir(outDir, { recursive: true });
  let extracted = 0;
  for (const zip of zips) {
    const mine = todo.filter((e) => e.zip === zip);
    if (!mine.length) continue;
    const listFile = join(outDir, `.extract-${process.pid}.txt`);
    await Bun.write(listFile, mine.map((e) => literal(e.path)).join("\n") + "\n");
    try {
      await sh(["bsdtar", "-xf", zip, "-C", outDir, "-T", listFile]);
    } finally {
      await rm(listFile, { force: true });
    }
    extracted += mine.length;
    log(`  ${basename(zip)}: ${mine.length} files`);
  }
  return { stats, extracted, bytes };
}
