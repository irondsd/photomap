/**
 * Dates for photos whose own metadata has none, from other files around them:
 *   1. the unedited original next to an edited copy        → "original" (exact)
 *   2. numbered neighbours taken the same day               → "sequence" (minutes)
 *   3. when an editor saved the file (taken shortly before) → "edited" (days)
 *   4. numbered neighbours further apart                    → "sequence" (rough)
 *   5. the year in the folder name ("Photos from 2012")     → "folder" (year only)
 * Dates that contradict their folder's year (a camera clock never set, a date fixed in
 * Google Photos, a copy made years later) are replaced too: by a correctly dated twin of
 * the same shot elsewhere, or else by the folder year.
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
  /** When an editor saved the file (UTC seconds), for photos without a date; see editedAt. */
  savedAt?: number | null;
  /** Camera model, to tell a copy of the same shot from another camera's file of the same name. */
  model?: string | null;
}

export interface DateFix {
  id: number;
  local: number;
  offset: number | null;
  source: "original" | "sequence" | "edited" | "folder" | "mtime" | "filename-utc";
  /** Human-readable evidence, for the report. */
  detail: string;
}

/** Sources this step owns: recomputed on every run. */
export const INFERRED_DATE_SOURCES = new Set(["mtime", "original", "sequence", "edited", "folder"]);
/** Dates set by hand: never replaced by inference or a rescan, and not used as evidence for other photos. */
export const MANUAL_DATE_SOURCES = new Set(["manual", "manual-date"]);
/** Dates too vague to line photos up in time (backfill, sequence anchors). */
export const VAGUE_DATE_SOURCES = new Set(["mtime", "sequence", "edited", "folder", "gps-date", "manual-date"]);

const SEQ_SAME_DAY_S = 24 * 3600;
const SEQ_ONE_SIDE_MAX_STEP = 3;
const ZONE_WINDOW_S = 3 * 86400;
// Google files photos by UTC; near New Year a correct local time can land in the other year.
const NEW_YEAR_MARGIN_S = 36 * 3600;
// Save times are only day-precise anyway; any photo from the same month knows the zone.
const ZONE_WINDOW_LONG_S = 31 * 86400;
const EDIT_LAG_MAX_S = 30 * 86400;

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

const exact = (r: DateRow) =>
  r.t != null && !INFERRED_DATE_SOURCES.has(r.source ?? "mtime") && !VAGUE_DATE_SOURCES.has(r.source ?? "") && !MANUAL_DATE_SOURCES.has(r.source ?? "");

/** A date from another year than its folder's, and not just across New Year. */
export function contradictsFolder(t: number, year: number): boolean {
  if (new Date(t * 1000).getUTCFullYear() === year) return false;
  const start = Date.UTC(year, 0, 1) / 1000;
  const end = Date.UTC(year + 1, 0, 1) / 1000;
  return Math.abs(t - start) > NEW_YEAR_MARGIN_S && Math.abs(t - end) > NEW_YEAR_MARGIN_S;
}

/** A new image made from others (Google's collages): not a copy of one shot. */
const isDerived = (name: string) => /-collage(?=\.[^.]+$)/i.test(name);

/** "IMG_1938.tif", "IMG_1938-edited(1).JPG" → "img_1938": the same shot in any format. */
const shotStem = (name: string) =>
  name.replace(/(?:-edited|~\d+|\(\d+\))+(?=\.[^.]+$)/gi, "").replace(/\.[^.]+$/, "").toLowerCase();

export function inferDates(rows: DateRow[], machineOffset: (utcMs: number) => number): DateFix[] {
  const fixes: DateFix[] = [];

  // Camera dates their folder contradicts can't be evidence for anything else.
  const conflicted = new Set<DateRow>();
  for (const r of rows) {
    const y = folderYear(r.dir);
    if (exact(r) && y != null && contradictsFolder(r.t!, y)) conflicted.add(r);
  }
  const trusted = (r: DateRow) => exact(r) && !conflicted.has(r);

  const zones = zoneIndex(rows, trusted);
  const byDir = new Map<string, DateRow[]>();
  for (const r of rows) (byDir.get(r.dir) ?? byDir.set(r.dir, []).get(r.dir)!).push(r);

  fixes.push(...folderConflictFixes(rows, conflicted, trusted));

  for (const [dir, inDir] of byDir) {
    const anchors = inDir.filter(trusted);
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

      // 2.–4. Numbered neighbours and the editor's save time.
      let seqFix: ReturnType<typeof sequenceFix> = null;
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
        seqFix = sequenceFix(r, n, below, above);
        if (seqFix && !fits(seqFix.local)) seqFix = null;
      }
      const saved = r.savedAt != null && fits(r.savedAt) ? r.savedAt : null;
      const editedFix = (): DateFix => {
        const off = zones(saved!, ZONE_WINDOW_LONG_S) ?? machineOffset(saved! * 1000);
        return { id: r.id, local: saved! + off * 60, offset: off, source: "edited", detail: "when an editor saved the file" };
      };

      if (seqFix?.tight) {
        fixes.push(seqFix); // same-day neighbours: minutes
        continue;
      }
      if (seqFix && saved != null) {
        // A photo is taken before it's edited. A rough neighbour estimate that fits that
        // (up to a month before the save) is kept; one after the save is impossible.
        const u = seqFix.local - (seqFix.offset ?? 0) * 60;
        fixes.push(u <= saved + 3600 && saved - u <= EDIT_LAG_MAX_S ? seqFix : editedFix());
        continue;
      }
      if (seqFix || saved != null) {
        fixes.push(seqFix ?? editedFix());
        continue;
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

  fixes.push(...zoneFixes(rows, zones));
  return fixes;
}

function sequenceFix(r: DateRow, n: number, below?: { n: number; r: DateRow }, above?: { n: number; r: DateRow }): (DateFix & { tight: boolean }) | null {
  const name = (x: { r: DateRow }) => x.r.name;
  if (below && above) {
    const tb = below.r.t!;
    const ta = above.r.t!;
    // Counters only go up; if they don't here, it's two cameras (or a reset) sharing names.
    if (ta < tb) return null;
    if (ta - tb <= SEQ_SAME_DAY_S) {
      const k = (n - below.n) / (above.n - below.n);
      return { id: r.id, local: Math.round(tb + (ta - tb) * k), offset: below.r.offset, source: "sequence", detail: `between ${name(below)} and ${name(above)}`, tight: true };
    }
    // Days apart: it most likely belongs with whichever neighbour is closer in the numbering.
    const near = n - below.n <= above.n - n ? below : above;
    return { id: r.id, local: near.r.t!, offset: near.r.offset, source: "sequence", detail: `near ${name(near)} (between ${name(below)} and ${name(above)})`, tight: false };
  }
  const only = below ?? above;
  if (only && Math.abs(only.n - n) <= SEQ_ONE_SIDE_MAX_STEP) {
    return { id: r.id, local: only.r.t!, offset: only.r.offset, source: "sequence", detail: `near ${name(only)}`, tight: false };
  }
  return null;
}

/**
 * Time zone at a UTC moment, from photos with a known offset taken within a few days.
 * Exact instants without a location (file name timestamps, editor save times) borrow it.
 */
function zoneIndex(rows: DateRow[], trusted: (r: DateRow) => boolean): (utc: number, window?: number) => number | null {
  const known = rows
    .filter((r) => r.t != null && r.offset != null && trusted(r) && r.source !== "filename-utc" && r.source !== "video")
    .map((r) => ({ u: r.t! - r.offset! * 60, offset: r.offset! }))
    .sort((a, b) => a.u - b.u);
  return (u, window = ZONE_WINDOW_S) => {
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
    return best && Math.abs(best.u - u) <= window ? best.offset : null;
  };
}

/** A timestamp in a file name is an exact instant; without a location it got this Mac's zone. */
function zoneFixes(rows: DateRow[], zones: (utc: number) => number | null): DateFix[] {
  const out: DateFix[] = [];
  for (const r of rows) {
    if (r.source !== "filename-utc" || r.lat != null || r.t == null || r.offset == null) continue;
    const u = r.t - r.offset * 60;
    const off = zones(u);
    if (off == null || off === r.offset) continue;
    out.push({ id: r.id, local: u + off * 60, offset: off, source: "filename-utc", detail: "zone of photos taken around then" });
  }
  return out;
}

/**
 * Photos whose own date contradicts their folder: the same shot with a trustworthy date
 * elsewhere wins (IMG_1938.tif made in 2019 from IMG_1938.JPG of 2011); otherwise the
 * folder year does, keeping the photos' order within it.
 */
function folderConflictFixes(rows: DateRow[], conflicted: Set<DateRow>, trusted: (r: DateRow) => boolean): DateFix[] {
  const twins = new Map<string, DateRow[]>();
  for (const r of rows) {
    if (!r.model || !trusted(r) || isDerived(r.name)) continue;
    const key = `${shotStem(r.name)}|${r.model}`;
    (twins.get(key) ?? twins.set(key, []).get(key)!).push(r);
  }

  const fixes: DateFix[] = [];
  const toFolder = new Map<string, DateRow[]>();
  for (const r of conflicted) {
    const twin = r.model && !isDerived(r.name) ? twins.get(`${shotStem(r.name)}|${r.model}`)?.find((x) => x.id !== r.id) : undefined;
    if (twin) {
      fixes.push({ id: r.id, local: twin.t!, offset: twin.offset, source: "original", detail: `same shot as ${twin.name}` });
    } else {
      (toFolder.get(r.dir) ?? toFolder.set(r.dir, []).get(r.dir)!).push(r);
    }
  }
  for (const [dir, list] of toFolder) {
    const year = folderYear(dir)!;
    const start = Date.UTC(year, 0, 1) / 1000;
    for (const r of list) {
      // Year only. Keeping the camera's time of day on that first day keeps a burst in
      // shooting order, whatever else the folder holds.
      const local = start + (((r.t! % 86400) + 86400) % 86400);
      fixes.push({ id: r.id, local, offset: null, source: "folder", detail: `camera date ${new Date(r.t! * 1000).getUTCFullYear()} contradicts folder "${dir}"` });
    }
  }
  return fixes;
}
