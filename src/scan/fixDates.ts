import { db } from "../db";
import { inferDates, type DateFix, type DateRow } from "./dates";

/**
 * Runs date inference (dates.ts) over the whole library and stores the result.
 * Returns how many photos each source now covers.
 */
export function applyDateInference(): Record<DateFix["source"], number> {
  const rows = db
    .query<DateRow, []>(
      `SELECT p.id, r.path || '/' || p.rel_dir AS dir, p.name, p.taken_local AS t, p.tz_offset AS offset,
              p.time_source AS source, p.lat, p.mtime AS mtimeMs
       FROM photos p JOIN roots r ON r.id = p.root_id WHERE p.missing = 0`,
    )
    .all();
  const fixes = inferDates(rows, (ms) => -new Date(ms).getTimezoneOffset());
  const set = db.prepare(`UPDATE photos SET taken_local = ?, tz_offset = ?, time_source = ? WHERE id = ?`);
  db.transaction(() => {
    for (const f of fixes) set.run(f.local, f.offset, f.source, f.id);
  })();
  const counts = { original: 0, sequence: 0, folder: 0, mtime: 0, "filename-utc": 0 };
  for (const f of fixes) counts[f.source]++;
  return counts;
}
