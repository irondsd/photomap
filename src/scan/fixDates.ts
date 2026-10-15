import { db } from "../db";
import { editedAt } from "./extract";
import { inferDates, INFERRED_DATE_SOURCES, type DateFix, type DateRow } from "./dates";

/**
 * Runs date inference (dates.ts) over the whole library and stores the result.
 * Returns how many photos each source now covers. With `only`, the whole library is still
 * read as evidence, but only those photos are updated.
 */
export async function applyDateInference(only?: Iterable<number>): Promise<Record<DateFix["source"], number>> {
  const targets = only ? new Set(only) : null;
  const rows = db
    .query<DateRow & { path: string }, []>(
      `SELECT p.id, r.path || '/' || p.rel_dir AS dir, p.path, p.name, p.taken_local AS t, p.tz_offset AS offset,
              p.time_source AS source, p.lat, p.mtime AS mtimeMs, p.model
       FROM photos p JOIN roots r ON r.id = p.root_id WHERE p.missing = 0`,
    )
    .all();

  // Editor save times, only for photos still without a date of their own.
  const undated = rows.filter((r) => INFERRED_DATE_SOURCES.has(r.source ?? "mtime") && (!targets || targets.has(r.id)));
  let i = 0;
  await Promise.all(
    Array.from({ length: 16 }, async () => {
      while (i < undated.length) {
        const r = undated[i++]!;
        r.savedAt = await editedAt(r.path);
      }
    }),
  );

  const fixes = inferDates(rows, (ms) => -new Date(ms).getTimezoneOffset()).filter(
    (f) => !targets || targets.has(f.id),
  );
  const set = db.prepare(`UPDATE photos SET taken_local = ?, tz_offset = ?, time_source = ? WHERE id = ?`);
  db.transaction(() => {
    for (const f of fixes) set.run(f.local, f.offset, f.source, f.id);
  })();
  const counts = { original: 0, sequence: 0, edited: 0, folder: 0, mtime: 0, "filename-utc": 0 };
  for (const f of fixes) counts[f.source]++;
  return counts;
}
