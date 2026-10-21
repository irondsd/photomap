#!/usr/bin/env bun
/**
 * bun run estimates <file.json> [--min=high|medium|low] [--dry-run]
 *   Applies reviewed location estimates: a JSON array of { id, lat, lon, confidence }
 *   (e.g. worked out series by series from the photos with GPS around them). Default
 *   --min=medium. Only photos that still have no location (or an earlier estimate from
 *   this command) are changed; they're marked gps_source = "inferred:series".
 * bun run estimates --undo
 *   Removes every location set by this command.
 *
 * Only the index changes; files are never written (writeback skips inferred locations).
 * `bun run backfill` leaves these alone.
 */
import { db } from "../db";
import { setLocation } from "./locate";

const SOURCE = "inferred:series";
const LEVELS = ["high", "medium", "low"] as const;
type Level = (typeof LEVELS)[number];

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const minArg = argv.find((a) => a.startsWith("--min="))?.slice(6) ?? "medium";
if (!LEVELS.includes(minArg as Level)) fail(`--min=${minArg}: expected high, medium or low`);
const min = minArg as Level;

if (argv.includes("--undo")) {
  const ids = db.query<{ id: number }, [string]>(`SELECT id FROM photos WHERE gps_source = ?`).all(SOURCE);
  if (!dryRun) db.transaction(() => ids.forEach(({ id }) => setLocation(id, null)))();
  console.log(`${dryRun ? "Would remove" : "Removed"} ${ids.length} series estimates.`);
  process.exit(0);
}

const file = argv.find((a) => !a.startsWith("--"));
if (!file) fail("expected a JSON file of estimates");

interface Estimate {
  id: number;
  lat: number | null;
  lon: number | null;
  confidence: Level | "none";
}
const estimates: Estimate[] = await Bun.file(file).json();
const chosen = estimates.filter(
  (e) =>
    e.lat != null &&
    e.lon != null &&
    Math.abs(e.lat) <= 90 &&
    Math.abs(e.lon) <= 180 &&
    LEVELS.indexOf(e.confidence as Level) !== -1 &&
    LEVELS.indexOf(e.confidence as Level) <= LEVELS.indexOf(min),
);

const srcStmt = db.prepare<{ src: string | null; missing: number }, [number]>(
  `SELECT gps_source src, missing FROM photos WHERE id = ?`,
);
let applied = 0;
let taken = 0;
let gone = 0;
db.transaction(() => {
  for (const e of chosen) {
    const row = srcStmt.get(e.id);
    if (!row || row.missing) gone++;
    else if (row.src != null && row.src !== SOURCE) taken++;
    else {
      if (!dryRun) setLocation(e.id, { lat: e.lat!, lon: e.lon!, source: SOURCE });
      applied++;
    }
  }
})();

const counts = LEVELS.map((l) => `${chosen.filter((e) => e.confidence === l).length} ${l}`).join(", ");
console.log(`${chosen.length} of ${estimates.length} estimates at ${min} confidence or above (${counts})`);
if (taken) console.log(`  ${taken} skipped: the photo has a location from its file, by hand or from backfill`);
if (gone) console.log(`  ${gone} skipped: not in the index any more`);
console.log(dryRun ? `Dry run — would apply ${applied}.` : `Applied ${applied}. Undo with: bun run estimates --undo`);
