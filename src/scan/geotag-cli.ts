#!/usr/bin/env bun
/**
 * bun run geotag <lat,lon> <from> [to] [--dry-run]
 *   Tags photos without GPS taken between <from> and <to> (local time at that place).
 *   <from>/<to>: "2019-07-14" (whole day) or "2019-07-14 15:00". Without <to>, a date
 *   means that day and a time means that minute.
 * bun run geotag --clear <from> [to]
 *   Removes manual locations in that range.
 *
 * Coordinates can be pasted from Google Maps: "48.858370, 2.294481".
 * Only the index changes. Photos with real GPS are never touched.
 */
import { db } from "../db";
import { countryAt } from "./extract";
import { timeZoneAt, zoneOffsetAtWall } from "./datetime";
import { setLocation } from "./locate";

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const clear = argv.includes("--clear");
let rest = argv.filter((a) => !a.startsWith("--"));

let loc: { lat: number; lon: number } | null = null;
if (!clear) {
  // "48.85, 2.29" arrives as one argument when quoted, two when not.
  const COORDS = /^\s*(-?\d+(?:\.\d+)?)\s*,?\s*(-?\d+(?:\.\d+)?)\s*$/;
  const one = /,\s*-?\d/.test(rest[0] ?? "") ? COORDS.exec(rest[0]!) : null;
  const m = one ?? COORDS.exec(`${rest[0] ?? ""} ${rest[1] ?? ""}`);
  if (!m) fail(`expected coordinates like "48.858370, 2.294481", got ${rest[0] ?? "nothing"}`);
  loc = { lat: Number(m[1]), lon: Number(m[2]) };
  if (Math.abs(loc.lat) > 90 || Math.abs(loc.lon) > 180) fail("coordinates out of range");
  rest = rest.slice(one ? 1 : 2);
}

/** Wall-clock seconds (as UTC) for "YYYY-MM-DD[ HH:MM[:SS]]", plus the length of the span it names. */
function parseWall(s: string | undefined): { t: number; span: number } {
  const m = s && /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s.trim());
  if (!m) fail(`expected a date like "2019-07-14" or "2019-07-14 15:00", got ${s ?? "nothing"}`);
  const t = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) / 1000;
  return { t, span: m[4] == null ? 86400 : m[6] == null ? 60 : 1 };
}

const from = parseWall(rest[0]);
const to = rest[1] ? parseWall(rest[1]) : null;
const wallFrom = from.t;
const wallTo = to ? to.t + (to.span === 86400 ? 86400 : 0) : from.t + from.span;
if (wallTo <= wallFrom) fail("the end of the range is before its start");

interface Row {
  id: number;
  name: string;
  t: number;
  offset: number | null;
  src: string | null;
}
const rows = db
  .query<Row, []>(
    `SELECT id, name, taken_local t, tz_offset offset, gps_source src FROM photos WHERE missing = 0 AND taken_local IS NOT NULL`,
  )
  .all();

let picked: Row[];
if (loc) {
  // Compare real instants, so photos whose stored local time is in the wrong zone still match.
  const tz = timeZoneAt(loc.lat, loc.lon);
  const off = (wall: number) => (tz ? zoneOffsetAtWall(tz, wall) : 0);
  const uFrom = wallFrom - off(wallFrom) * 60;
  const uTo = wallTo - off(wallTo) * 60;
  picked = rows.filter((r) => {
    const u = r.t - (r.offset ?? off(r.t)) * 60;
    return u >= uFrom && u < uTo;
  });
} else {
  picked = rows.filter((r) => r.t >= wallFrom && r.t < wallTo);
}

const assignable = (r: Row) => r.src == null || r.src === "manual" || r.src.startsWith("inferred:");
const targets = (clear ? picked.filter((r) => r.src === "manual") : picked.filter(assignable)).sort(
  (a, b) => a.t - b.t,
);
const realGps = picked.filter((r) => !assignable(r)).length;

const fmt = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");
for (const r of targets) console.log(`  ${fmt(r.t)}  ${r.name}${r.src ? `  (was ${r.src})` : ""}`);
const place = loc ? `${loc.lat}, ${loc.lon} (${countryAt(loc.lat, loc.lon).name ?? "?"})` : "";
console.log(
  `\n${targets.length} photo(s) ${clear ? "to clear" : `to tag at ${place}`}` +
    (realGps ? `; ${realGps} in range already have GPS and are left alone` : ""),
);

if (dryRun || !targets.length) {
  if (dryRun) console.log("Dry run — nothing changed.");
  process.exit(0);
}
db.transaction(() => {
  for (const r of targets) setLocation(r.id, loc ? { ...loc, source: "manual" } : null);
})();
console.log(clear ? "Cleared." : "Tagged.");
