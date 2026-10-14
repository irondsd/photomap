/**
 * Dates for photos whose own metadata has none, from other files around them:
 *   1. the unedited original next to an edited copy        → "original" (exact)
 *   2. the files numbered just before and after it          → "sequence" (estimate)
 *   3. the year in the folder name ("Photos from 2012")     → "folder" (year only)
 * Also gives millisecond-timestamp file names (exact instants, unknown zone) the time
 * zone of photos taken around the same time.
 */

export interface DateRow {
  id: number;
  /** Folder relative to its root; inference only looks within one folder. */
  dir: string;
  name: string;
  t: number | null;
  offset: number | null;
  source: string | null;
  lat: number | null;
  mtimeMs: number;
}

export interface DateFix {
  id: number;
  local: number;
  offset: number | null;
  source: "original" | "sequence" | "folder" | "mtime" | "filename-utc";
  /** Human-readable evidence, for the report. */
  detail: string;
}

/** Sources this step owns: recomputed on every run. */
export const INFERRED_DATE_SOURCES = new Set(["mtime", "original", "sequence", "folder"]);
/** Dates too vague to line photos up in time (backfill, sequence anchors). */
export const VAGUE_DATE_SOURCES = new Set(["mtime", "sequence", "folder", "gps-date"]);

const SEQ_SAME_DAY_S = 24 * 3600;
const SEQ_ONE_SIDE_MAX_STEP = 3;
const ZONE_WINDOW_S = 3 * 86400;

/** "IMAG0170-edited(1).jpg" → "imag0170.jpg": the name of the file it was made from. */
export function originalName(name: string): string {
  return name.replace(/(?:-edited|-collage|~\d+|\(\d+\))+(?=\.[^.]+$)/gi, "").toLowerCase();
}

/** "IMG_2586.JPG" → ["img_", 2586]; null for names without a camera counter. */
export function sequenceOf(name: string): [string, number] | null {
  const stem = originalName(name).replace(/\.[^.]+$/, "");
  const m = /^([a-z_\- ]*?)(\d{3,6})$/.exec(stem);
  return m ? [m[1]!, Number(m[2])] : null;
}

/** Year from "Photos from 2012" (Google Takeout) or a folder named "2012". */
export function folderYear(dir: string): number | null {
  const last = dir.split(/[\\/]/).pop() ?? "";
  const m = /^(?:Photos from )?((?:19|20)\d{2})$/.exec(last);
  return m ? Number(m[1]) : null;
}

const exact = (r: DateRow) => r.t != null && !INFERRED_DATE_SOURCES.has(r.source ?? "mtime") && !VAGUE_DATE_SOURCES.has(r.source ?? "");

export function inferDates(rows: DateRow[], machineOffset: (utcMs: number) => number): DateFix[] {
  const fixes: DateFix[] = [];
  const byDir = new Map<string, DateRow[]>();
  for (const r of rows) (byDir.get(r.dir) ?? byDir.set(r.dir, []).get(r.dir)!).push(r);

  for (const [dir, inDir] of byDir) {
    const anchors = inDir.filter(exact);
    const byName = new Map(anchors.map((a) => [a.name.toLowerCase(), a]));
    const sequences = new Map<string, { n: number; r: DateRow }[]>();
    for (const a of anchors) {
      const s = sequenceOf(a.name);
      if (s) (sequences.get(s[0]) ?? sequences.set(s[0], []).get(s[0])!).push({ n: s[1], r: a });
    }
    for (const list of sequences.values()) list.sort((x, y) => x.n - y.n);
    const year = folderYear(dir);

    for (const r of inDir) {
      if (!INFERRED_DATE_SOURCES.has(r.source ?? "mtime")) continue;

      // A folder year (Google's own record of when the file was made) overrules evidence
      // from neighbours: a collage made in 2018 is numbered after its 2012 originals.
      const fits = (local: number) => year == null || new Date(local * 1000).getUTCFullYear() === year;

      // 1. The original it was edited from.
      const orig = byName.get(originalName(r.name));
      if (orig && orig !== r && fits(orig.t!)) {
        fixes.push({ id: r.id, local: orig.t!, offset: orig.offset, source: "original", detail: `from ${orig.name}` });
        continue;
      }

      // 2. Its neighbours in the camera's numbering.
      const seq = sequenceOf(r.name);
      const list = seq ? sequences.get(seq[0]) : undefined;
      if (seq && list) {
        const n = seq[1];
        let below: { n: number; r: DateRow } | undefined;
        let above: { n: number; r: DateRow } | undefined;
        for (const x of list) {
          if (x.n < n) below = x;
          else if (x.n > n && !above) above = x;
        }
        const fix = sequenceFix(r, n, below, above);
        if (fix && fits(fix.local)) {
          fixes.push(fix);
          continue;
        }
      }

      // 3. The folder's year: the first moment of it, so it sorts at the end of that year.
      if (year != null) {
        fixes.push({ id: r.id, local: Date.UTC(year, 0, 1) / 1000, offset: null, source: "folder", detail: `year from folder "${dir}"` });
        continue;
      }

      // Nothing better: back to the file's modified time (it may have held an older guess).
      if (r.source !== "mtime") {
        const utc = Math.floor(r.mtimeMs / 1000);
        const off = machineOffset(r.mtimeMs);
        fixes.push({ id: r.id, local: utc + off * 60, offset: off, source: "mtime", detail: "no other clue" });
      }
    }
  }

  fixes.push(...zoneFixes(rows));
  return fixes;
}

function sequenceFix(r: DateRow, n: number, below?: { n: number; r: DateRow }, above?: { n: number; r: DateRow }): DateFix | null {
  const name = (x: { r: DateRow }) => x.r.name;
  if (below && above) {
    const tb = below.r.t!;
    const ta = above.r.t!;
    // Counters only go up; if they don't here, it's two cameras (or a reset) sharing names.
    if (ta < tb) return null;
    if (ta - tb <= SEQ_SAME_DAY_S) {
      const k = (n - below.n) / (above.n - below.n);
      return { id: r.id, local: Math.round(tb + (ta - tb) * k), offset: below.r.offset, source: "sequence", detail: `between ${name(below)} and ${name(above)}` };
    }
    // Days apart: it most likely belongs with whichever neighbour is closer in the numbering.
    const near = n - below.n <= above.n - n ? below : above;
    return { id: r.id, local: near.r.t!, offset: near.r.offset, source: "sequence", detail: `near ${name(near)} (between ${name(below)} and ${name(above)})` };
  }
  const only = below ?? above;
  if (only && Math.abs(only.n - n) <= SEQ_ONE_SIDE_MAX_STEP) {
    return { id: r.id, local: only.r.t!, offset: only.r.offset, source: "sequence", detail: `near ${name(only)}` };
  }
  return null;
}

/**
 * A timestamp in a file name is an exact instant but says nothing about the zone; without
 * a location it got this Mac's zone. Use the zone of photos taken within a few days.
 */
function zoneFixes(rows: DateRow[]): DateFix[] {
  const known = rows
    .filter((r) => r.t != null && r.offset != null && exact(r) && r.source !== "filename-utc" && r.source !== "video")
    .map((r) => ({ u: r.t! - r.offset! * 60, offset: r.offset! }))
    .sort((a, b) => a.u - b.u);
  const out: DateFix[] = [];
  for (const r of rows) {
    if (r.source !== "filename-utc" || r.lat != null || r.t == null || r.offset == null) continue;
    const u = r.t - r.offset * 60;
    let lo = 0;
    let hi = known.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (known[mid]!.u < u) lo = mid + 1;
      else hi = mid;
    }
    const a = known[lo - 1];
    const b = known[lo];
    const best = !a ? b : !b ? a : u - a.u <= b.u - u ? a : b;
    if (!best || Math.abs(best.u - u) > ZONE_WINDOW_S || best.offset === r.offset) continue;
    out.push({ id: r.id, local: u + best.offset * 60, offset: best.offset, source: "filename-utc", detail: "zone of photos taken around then" });
  }
  return out;
}
