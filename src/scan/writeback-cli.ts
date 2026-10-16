#!/usr/bin/env bun
/**
 * bun run writeback [folder…] [-v]
 *   Dry run: which files would get the dates and locations you set by hand.
 * bun run writeback [folder…] --apply [--no-backup]
 *   Writes them into the files with exiftool (EXIF for photos, QuickTime tags for videos).
 *   exiftool keeps each untouched file next to it as "<name>_original", unless --no-backup.
 *
 * The only command that changes photo files. Files that already agree are skipped, so it
 * can be re-run after every editing session. Inferred dates and locations are never written.
 */
import { existsSync } from "node:fs";
import { sep } from "node:path";
import { CPUS } from "../config";
import { db, type PhotoRow } from "../db";
import { extract } from "./extract";
import { expandHome, joinSplitPaths, normalizeFolder } from "./roots";
import {
  exifDate,
  exifOffset,
  exiftoolArgs,
  pendingChange,
  writeFile,
  type Change,
  type WritebackRow,
} from "./writeback";

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const overwrite = args.includes("--no-backup");
const verbose = args.includes("-v") || args.includes("--verbose");
const unknown = args.find((a) => a.startsWith("-") && !["--apply", "--no-backup", "-v", "--verbose"].includes(a));
if (unknown) fail(`unknown option ${unknown}`);

let folders: string[];
try {
  folders = joinSplitPaths(
    args.filter((a) => !a.startsWith("-")),
    (p) => existsSync(expandHome(p)),
  ).map(normalizeFolder);
} catch (err) {
  fail((err as Error).message);
}
if (apply && !Bun.which("exiftool")) fail("exiftool is not installed (brew install exiftool)");

type Row = WritebackRow & Pick<PhotoRow, "mtime">;
const rows = db
  .query<Row, []>(
    `SELECT id, path, name, kind, mtime, taken_local, tz_offset, time_source, lat, lon, gps_source FROM photos
     WHERE missing = 0 AND (gps_source = 'manual' OR time_source IN ('manual', 'manual-date'))
     ORDER BY path`,
  )
  .all()
  .filter((r) => !folders.length || folders.some((f) => r.path.startsWith(f + sep)));

async function pool<T>(items: T[], fn: (item: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(CPUS, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]!);
    }),
  );
}

// ------------------------------------------------------------ compare with the files
const pending: { row: Row; change: Change }[] = [];
const gone: Row[] = [];
await pool(rows, async (row) => {
  const f = Bun.file(row.path);
  if (!(await f.exists())) return void gone.push(row);
  const change = pendingChange(row, await extract(row.path, row.kind, row.name, f.lastModified));
  if (change) pending.push({ row, change });
});
pending.sort((a, b) => a.row.path.localeCompare(b.row.path));

const describe = (c: Change) =>
  [
    c.date && `date ${exifDate(c.date.local)}${c.date.offset != null ? ` ${exifOffset(c.date.offset)}` : ""}`,
    c.location && `location ${c.location.lat.toFixed(6)}, ${c.location.lon.toFixed(6)}`,
  ]
    .filter(Boolean)
    .join(", ");

if (verbose || (!apply && pending.length <= 50))
  for (const p of pending) console.log(`  ${p.row.path}  →  ${describe(p.change)}`);
const dates = pending.filter((p) => p.change.date).length;
const places = pending.filter((p) => p.change.location).length;
console.log(
  `\n${rows.length} file(s) with hand-set dates or locations; ${rows.length - pending.length - gone.length} already up to date.` +
    `\n${pending.length} to write: ${dates} date(s), ${places} location(s).` +
    (gone.length ? `\n${gone.length} no longer on disk (rescan to update the index).` : ""),
);

if (!apply) {
  if (pending.length > 50 && !verbose) console.log("Add -v for the full list.");
  console.log(`Dry run — nothing changed. Add --apply to write${pending.length ? "" : " (nothing to do)"}.`);
  process.exit(0);
}
if (!pending.length) process.exit(0);

// ------------------------------------------------------------ write
let done = 0;
const failed: { row: Row; error: string }[] = [];
await pool(pending, async ({ row, change }) => {
  const error = await writeFile(row.path, exiftoolArgs(row.kind, change, overwrite));
  if (error) return void failed.push({ row, error });
  // Read it back the way a scan would, so a tag the scanner can't see counts as a failure.
  const f = Bun.file(row.path);
  const left = pendingChange(row, await extract(row.path, row.kind, row.name, f.lastModified));
  if (left) failed.push({ row, error: `written, but reads back without the ${describe(left)}` });
  else done++;
  if ((done + failed.length) % 100 === 0) process.stdout.write(`\r  ${done + failed.length}/${pending.length}`);
});
process.stdout.write("\r");

for (const f of failed.sort((a, b) => a.row.path.localeCompare(b.row.path)))
  console.error(`  ✗ ${f.row.path}: ${f.error}`);
console.log(`Wrote ${done} file(s)${failed.length ? `; ${failed.length} failed` : ""}.`);
if (done && !overwrite) {
  console.log(`The originals were kept as "<name>_original". Once you're happy, remove them with:`);
  console.log(
    `  exiftool -delete_original! -r ${folders.length ? folders.map((f) => JSON.stringify(f)).join(" ") : "<folder>"}`,
  );
}
if (failed.length) process.exit(1);
