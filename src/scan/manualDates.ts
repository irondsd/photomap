import { db, getPhoto } from "../db";
import { extract, type Extracted } from "./extract";
import { parseDateString, relocalize, type TimeSource } from "./datetime";
import { MANUAL_DATE_SOURCES } from "./dates";
import { applyDateInference } from "./fixDates";

/** A date typed by hand: "2020-06-12", with an optional "14:30" or "14:30:05". */
export interface ManualDate {
  /** Wall-clock seconds; noon when no time was given, so no offset can move it to another day. */
  local: number;
  source: "manual" | "manual-date";
}

export const isManualDate = (source: string | null | undefined) => MANUAL_DATE_SOURCES.has(source ?? "");

/** Null when the date (or time) isn't a real one. */
export function parseManualDate(date: unknown, time?: unknown): ManualDate | null {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const hasTime = typeof time === "string" && time.trim() !== "";
  if (hasTime && !/^\d{2}:\d{2}(:\d{2})?$/.test(time.trim())) return null;
  const parsed = parseDateString(`${date} ${hasTime ? time.trim() : "12:00:00"}`);
  return parsed ? { local: parsed.wall, source: hasTime ? "manual" : "manual-date" } : null;
}

/** The time zone comes from the photo's location, when it has one. */
const placed = (d: ManualDate, lat: number | null, lon: number | null) => relocalize({ local: d.local, offset: null, source: d.source }, lat, lon);

const locStmt = db.prepare<{ lat: number | null; lon: number | null }, [number]>(`SELECT lat, lon FROM photos WHERE id = ?`);
const setStmt = db.prepare(`UPDATE photos SET taken_local = ?, tz_offset = ?, time_source = ? WHERE id = ?`);

/** Sets a date by hand. Returns false for an unknown photo. */
export function setManualDate(id: number, d: ManualDate): boolean {
  const loc = locStmt.get(id);
  if (!loc) return false;
  const t = placed(d, loc.lat, loc.lon);
  setStmt.run(t.local, t.offset, t.source, id);
  return true;
}

/** Re-applies a hand-set date to freshly extracted metadata (rescan, location reset). */
export function keepManualDate(meta: Extracted, prev: { taken_local: number | null; time_source: string | null }): Extracted {
  if (!isManualDate(prev.time_source) || prev.taken_local == null) return meta;
  const t = placed({ local: prev.taken_local, source: prev.time_source as ManualDate["source"] }, meta.lat, meta.lon);
  return { ...meta, taken_local: t.local, tz_offset: t.offset, time_source: t.source };
}

/**
 * Drops hand-set dates and goes back to what a fresh scan would find: the file's own
 * date, or one inferred from the files around it (e.g. the year in the folder name).
 * Photos without a hand-set date, or whose file is gone, are left alone.
 * Returns the ids that were reset.
 */
export async function resetManualDates(ids: number[]): Promise<number[]> {
  const done: number[] = [];
  for (const id of ids) {
    const p = getPhoto(id);
    if (!p || p.missing || !isManualDate(p.time_source)) continue;
    const meta = await extract(p.path, p.kind, p.name, p.mtime);
    let t = { local: meta.taken_local, offset: meta.tz_offset, source: meta.time_source };
    // A location set by hand or inferred also sets the time zone, as in a rescan (see keepAssignedLocation).
    const assigned = p.gps_source === "manual" || !!p.gps_source?.startsWith("inferred:");
    if (assigned && p.lat != null && p.lon != null && t.local != null && t.source) {
      const r = relocalize({ local: t.local, offset: t.offset, source: t.source as TimeSource }, p.lat, p.lon);
      t = { local: r.local, offset: r.offset, source: r.source };
    }
    setStmt.run(t.local, t.offset, t.source, id);
    done.push(id);
  }
  if (done.length) await applyDateInference(done);
  return done;
}
