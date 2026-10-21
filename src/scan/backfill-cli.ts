#!/usr/bin/env bun
/**
 * bun run backfill                 dry run: show what would be inferred
 * bun run backfill --apply=high    write inferences at or above a confidence (high | medium | low)
 * bun run backfill --undo          remove every inferred location
 *
 * Only the index is changed; photo files are never written. Inferred locations are
 * marked gps_source = "inferred:<rule>" and recomputed on every run.
 */
import { db } from "../db";
import { countryAt } from "./extract";
import { infer, type BackfillPhoto, type Confidence, type Proposal, type Rule } from "./backfill";
import { setLocation } from "./locate";
import { VAGUE_DATE_SOURCES } from "./dates";

const args = process.argv.slice(2);
const undo = args.includes("--undo");
const applyArg = args.find((a) => a.startsWith("--apply"));
const LEVELS: Confidence[] = ["high", "medium", "low"];
const minLevel = applyArg ? ((applyArg.split("=")[1] ?? "high") as Confidence) : null;
if (minLevel && !LEVELS.includes(minLevel)) {
  console.error(`error: --apply=${minLevel}: expected high, medium or low`);
  process.exit(1);
}

/**
 * Sources this tool writes. Other inferred sources (`inferred:series`, estimates reviewed
 * series by series) are neither evidence nor overwritten here.
 */
const RULE_SOURCES = (["burst", "stay", "home", "nearby"] as const satisfies readonly Rule[]).map(
  (r) => `inferred:${r}`,
);
const ownSource = (src: string | null) => src != null && RULE_SOURCES.includes(src);

/** Removes every location this tool inferred (and the time-zone adjustments that came with it). */
function clearInferred(): number {
  const ids = db
    .query<{ id: number }, string[]>(
      `SELECT id FROM photos WHERE gps_source IN (${RULE_SOURCES.map(() => "?").join(", ")})`,
    )
    .all(...RULE_SOURCES);
  for (const { id } of ids) setLocation(id, null);
  return ids.length;
}

if (undo) {
  console.log(`Removed ${db.transaction(clearInferred)()} inferred locations.`);
  process.exit(0);
}

interface Row {
  id: number;
  t: number | null;
  offset: number | null;
  lat: number | null;
  lon: number | null;
  src: string | null;
  timeSource: string | null;
  name: string;
  country: string | null;
}
const rows: Row[] = db
  .query<Row, []>(
    `SELECT id, taken_local t, tz_offset offset, lat, lon, gps_source src, time_source timeSource, name, country
     FROM photos WHERE missing = 0`,
  )
  .all();
// Previous inferences are recomputed, never used as evidence. Vague dates (the file's
// modified time, a year from the folder, an estimate from numbered neighbours, a day
// without a time) can't line photos up within minutes, so those photos count as undated.
const photos: BackfillPhoto[] = rows
  .map((r) => (r.src?.startsWith("inferred:") ? { ...r, lat: null, lon: null } : r))
  .map((r) => ({ ...r, t: r.t != null && !VAGUE_DATE_SOURCES.has(r.timeSource ?? "") ? r.t : NaN }));
const byId = new Map<number, Row>(rows.map((r): [number, Row] => [r.id, r]));

const inferred = infer(photos);
const kept = (id: number) => {
  const src = byId.get(id)!.src;
  return !!src?.startsWith("inferred:") && !ownSource(src);
};
const { homes } = inferred;
const proposals = inferred.proposals.filter((p) => !kept(p.id));
const skipped = inferred.skipped.filter((p) => !kept(p.id));

// ------------------------------------------------------------ report
const date = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");
const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const gap = (m: number) =>
  m < 90 ? `${Math.round(m)} min` : m < 48 * 60 ? `${(m / 60).toFixed(1)} h` : `${(m / 1440).toFixed(1)} days`;
const untagged = photos.filter((p) => p.lat == null && !kept(p.id)).length;

console.log(`${untagged} photos without a GPS location\n`);
console.log("Homes detected (places photographed on 20+ distinct days):");
for (const h of homes) {
  console.log(
    `  ${countryAt(h.lat, h.lon).name ?? "?"} ${h.lat.toFixed(4)},${h.lon.toFixed(4)}  ${h.days} days  ${day(h.first)} → ${day(h.last)}`,
  );
}

const RULE_LABEL = {
  burst: "burst (fix within 15 min)",
  stay: "stayed put (same spot before & after, < 24 h)",
  home: "probably home (same spot at a home, < 7 days)",
  nearby: "nearby (fix within 1 h, same area ±5 km)",
};
console.log("\nCan infer:");
for (const rule of ["burst", "stay", "home", "nearby"] as const) {
  const of = proposals.filter((p) => p.rule === rule);
  if (!of.length) continue;
  const counts = LEVELS.map((l) => [l, of.filter((p) => p.confidence === l).length] as const).filter(([, n]) => n);
  console.log(
    `  ${String(of.length).padStart(4)}  ${RULE_LABEL[rule]}  — ${counts.map(([l, n]) => `${n} ${l}`).join(", ")}`,
  );
}
const totals = LEVELS.map((l) => proposals.filter((p) => p.confidence === l).length);
console.log(
  `  ${String(proposals.length).padStart(4)}  total — ${totals[0]} high, ${totals[1]} medium, ${totals[2]} low`,
);

const REASON = {
  moving: "moving: places before and after differ",
  "neighbours-far-in-time": "nearest GPS photos too far away in time",
  "no-neighbours": "no GPS photos at all",
  undated: "no precise date (none, or only an estimate, the year or the day)",
} as const;
console.log(`\nLeft for manual review: ${skipped.length}`);
for (const [reason, label] of Object.entries(REASON)) {
  const n = skipped.filter((s) => s.reason === reason).length;
  if (n) console.log(`  ${String(n).padStart(4)}  ${label}`);
}

if (args.includes("--verbose") || args.includes("-v")) {
  const line = (p: Proposal) => {
    const r = byId.get(p.id)!;
    const src = byId.get(p.from[0]!)!;
    return `  ${p.confidence.padEnd(6)} ${p.rule.padEnd(5)} ${date(r.t!)}  ${r.name.padEnd(36)} ← ${gap(p.gapMin).padEnd(9)} ${countryAt(p.lat, p.lon).name ?? ""} (${src.name})`;
  };
  console.log("\nProposals:");
  for (const p of [...proposals].sort((a, b) => byId.get(a.id)!.t! - byId.get(b.id)!.t!)) console.log(line(p));
}

// ------------------------------------------------------------ apply
if (!minLevel) {
  console.log(`\nDry run — nothing changed. Add -v for the full list, or --apply=high|medium|low to write.`);
  process.exit(0);
}

const chosen = proposals.filter((p) => LEVELS.indexOf(p.confidence) <= LEVELS.indexOf(minLevel));
db.transaction(() => {
  clearInferred();
  for (const p of chosen) setLocation(p.id, { lat: p.lat, lon: p.lon, source: `inferred:${p.rule}` });
})();
console.log(
  `\nApplied ${chosen.length} inferred locations (${minLevel} confidence and above). Undo with: bun run backfill --undo`,
);
