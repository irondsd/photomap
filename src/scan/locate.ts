import { db } from "../db";
import { countryAt, type Extracted } from "./extract";
import { relocalize, type TimeSource } from "./datetime";

/** Location sources that came from a person or an inference, never from the file itself. */
export type AssignedSource = "manual" | `inferred:${string}`;

interface Row {
  taken_local: number | null;
  tz_offset: number | null;
  time_source: string | null;
}

const getStmt = db.prepare<Row, [number]>(`SELECT taken_local, tz_offset, time_source FROM photos WHERE id = ?`);
const setStmt = db.prepare(
  `UPDATE photos SET lat = ?, lon = ?, alt = NULL, gps_source = ?, country_code = ?, country = ?,
     taken_local = ?, tz_offset = ?, time_source = ?
   WHERE id = ?`,
);

/**
 * Sets (or with `null`, clears) a location the file doesn't carry, keeping country and
 * local time consistent with it. Callers must not use this on photos with real GPS.
 */
export function setLocation(id: number, loc: { lat: number; lon: number; source: AssignedSource } | null) {
  const r = getStmt.get(id);
  if (!r) return;
  let time = { local: r.taken_local, offset: r.tz_offset, source: r.time_source };
  if (r.taken_local != null && r.time_source) {
    const t = relocalize({ local: r.taken_local, offset: r.tz_offset, source: r.time_source as TimeSource }, loc?.lat ?? null, loc?.lon ?? null);
    time = { local: t.local, offset: t.offset, source: t.source };
  }
  const c = loc ? countryAt(loc.lat, loc.lon) : { code: null, name: null };
  setStmt.run(loc?.lat ?? null, loc?.lon ?? null, loc?.source ?? null, c.code, c.name, time.local, time.offset, time.source, id);
}

/** Re-applies a manual location to freshly extracted metadata of a file that changed on disk. */
export function keepManualLocation(meta: Extracted, lat: number, lon: number): Extracted {
  let time = { taken_local: meta.taken_local, tz_offset: meta.tz_offset, time_source: meta.time_source };
  if (meta.taken_local != null && meta.time_source) {
    const t = relocalize({ local: meta.taken_local, offset: meta.tz_offset, source: meta.time_source as TimeSource }, lat, lon);
    time = { taken_local: t.local, tz_offset: t.offset, time_source: t.source };
  }
  const c = countryAt(lat, lon);
  return { ...meta, ...time, lat, lon, alt: null, gps_source: "manual", country_code: c.code, country: c.name };
}
