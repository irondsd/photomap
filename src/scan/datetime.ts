import tzlookup from "tz-lookup";

/**
 * Times are stored as "wall clock" seconds: the local time where the photo was
 * taken, encoded as if it were UTC. That keeps a photo shot at 23:00 in Tokyo on
 * the right day in the timeline. When the UTC offset is known it's kept alongside.
 */
export interface TimeResult {
  local: number;
  offset: number | null;
  source: TimeSource;
}

export type TimeSource =
  | "exif+offset" // DateTimeOriginal + OffsetTimeOriginal
  | "exif+gps" // offset derived from the GPS UTC timestamp
  | "exif+geotz" // offset from the time zone at the GPS position
  | "exif" // wall time only, offset unknown
  | "video+offset"
  | "video"
  | "filename"
  | "mtime";

const MIN_YEAR = 1826;
const maxYear = () => new Date().getUTCFullYear() + 1;

function validWall(y: number, mo: number, d: number, h: number, mi: number, s: number): number | null {
  if (y < MIN_YEAR || y > maxYear() || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return null;
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  // Reject roll-overs like Feb 31.
  if (new Date(ms).getUTCDate() !== d) return null;
  return ms / 1000;
}

/** "+02:00", "-0530", "Z" → minutes east of UTC. */
export function parseOffset(s: string | undefined | null): number | null {
  if (!s) return null;
  const t = s.trim();
  if (t === "Z") return 0;
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(t);
  if (!m) return null;
  const v = (Number(m[2]) * 60 + Number(m[3])) * (m[1] === "-" ? -1 : 1);
  return Math.abs(v) <= 14 * 60 ? v : null;
}

/**
 * Parses EXIF ("2019:06:12 14:22:01") and ISO-ish ("2019-06-12T14:22:01.123+02:00")
 * date strings into wall seconds plus an offset when one is embedded.
 */
export function parseDateString(s: string | undefined | null): { wall: number; offset: number | null } | null {
  if (typeof s !== "string") return null;
  const m = /^\s*(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?/.exec(s);
  if (!m) return null;
  const wall = validWall(+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0));
  if (wall == null) return null;
  return { wall, offset: parseOffset(m[7]) };
}

/** Offset implied by comparing local EXIF time with the GPS (UTC) timestamp, rounded to 15 min. */
export function offsetFromGps(wall: number, gpsDate: unknown, gpsTime: unknown): number | null {
  if (typeof gpsDate !== "string" || !Array.isArray(gpsTime) || gpsTime.length < 3) return null;
  const dm = /^(\d{4})[:\-](\d{2})[:\-](\d{2})/.exec(gpsDate);
  if (!dm) return null;
  const [h, mi, s] = gpsTime.map(Number) as [number, number, number];
  if (![h, mi, s].every(Number.isFinite)) return null;
  const utc = Date.UTC(+dm[1]!, +dm[2]! - 1, +dm[3]!, 0, 0, 0) / 1000 + h * 3600 + mi * 60 + s;
  const diffMin = (wall - utc) / 60;
  const rounded = Math.round(diffMin / 15) * 15;
  // GPS fixes can lag the shutter by a few minutes; anything wildly off is junk.
  if (Math.abs(diffMin - rounded) > 5 || Math.abs(rounded) > 14 * 60) return null;
  return rounded;
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function zoneOffsetAtInstant(tz: string, utcMs: number): number {
  let dtf = dtfCache.get(tz);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    dtfCache.set(tz, dtf);
  }
  const p: Record<string, number> = {};
  for (const part of dtf.formatToParts(utcMs)) if (part.type !== "literal") p[part.type] = Number(part.value);
  const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60000);
}

export function timeZoneAt(lat: number, lon: number): string | null {
  try {
    return tzlookup(lat, lon);
  } catch {
    return null;
  }
}

/** Offset (minutes) of an IANA zone at a given wall-clock time. */
export function zoneOffsetAtWall(tz: string, wall: number): number {
  const guess = zoneOffsetAtInstant(tz, wall * 1000);
  return zoneOffsetAtInstant(tz, (wall - guess * 60) * 1000);
}

const FILENAME_DATETIME =
  /(?<!\d)(19[89]\d|20[0-4]\d)[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?:[-_ T.]|\sat\s)?([01]\d|2[0-3])[-_.]?([0-5]\d)[-_.]?([0-5]\d)/;
const FILENAME_DATE = /(?<!\d)(19[89]\d|20[0-4]\d)[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?!\d)/;

/** IMG_20190612_142201.jpg, PXL_20230101_101010123.jpg, IMG-20190612-WA0001.jpg, "Screenshot 2019-06-12 at 21.31.19". */
export function dateFromFilename(name: string): number | null {
  const m = FILENAME_DATETIME.exec(name);
  if (m) {
    const w = validWall(+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
    if (w != null) return w;
  }
  const d = FILENAME_DATE.exec(name);
  if (d) {
    // Noon, so an unknown offset can't push it onto the neighbouring day.
    return validWall(+d[1]!, +d[2]!, +d[3]!, 12, 0, 0);
  }
  return null;
}

export interface TimeInput {
  exif?: {
    DateTimeOriginal?: unknown;
    CreateDate?: unknown;
    ModifyDate?: unknown;
    OffsetTimeOriginal?: unknown;
    OffsetTimeDigitized?: unknown;
    OffsetTime?: unknown;
    GPSDateStamp?: unknown;
    GPSTimeStamp?: unknown;
  };
  video?: { creationDate?: string; creationTime?: string };
  lat?: number | null;
  lon?: number | null;
  name: string;
  /** File mtime in ms (a real UTC instant). */
  mtimeMs: number;
}

function geoOffset(lat: number | null | undefined, lon: number | null | undefined, wall: number): number | null {
  if (lat == null || lon == null) return null;
  const tz = timeZoneAt(lat, lon);
  return tz ? zoneOffsetAtWall(tz, wall) : null;
}

function localOffsetAtInstant(ms: number): number {
  return -new Date(ms).getTimezoneOffset();
}

export function resolveTime(i: TimeInput): TimeResult | null {
  const e = i.exif;
  if (e) {
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    const candidates: [unknown, unknown][] = [
      [e.DateTimeOriginal, e.OffsetTimeOriginal],
      [e.CreateDate, e.OffsetTimeDigitized],
      [e.ModifyDate, e.OffsetTime],
    ];
    for (const [dateVal, offVal] of candidates) {
      const parsed = parseDateString(str(dateVal));
      if (!parsed) continue;
      const wall = parsed.wall;
      const embedded = parsed.offset ?? parseOffset(str(offVal));
      if (embedded != null) return { local: wall, offset: embedded, source: "exif+offset" };
      const gps = offsetFromGps(wall, e.GPSDateStamp, e.GPSTimeStamp);
      if (gps != null) return { local: wall, offset: gps, source: "exif+gps" };
      const geo = geoOffset(i.lat, i.lon, wall);
      if (geo != null) return { local: wall, offset: geo, source: "exif+geotz" };
      return { local: wall, offset: null, source: "exif" };
    }
  }

  const v = i.video;
  if (v) {
    // Apple writes local time with an offset; that's the best we can get.
    const cd = parseDateString(v.creationDate);
    if (cd) {
      return cd.offset != null
        ? { local: cd.wall, offset: cd.offset, source: "video+offset" }
        : { local: cd.wall, offset: null, source: "video" };
    }
    // creation_time is UTC by spec. 1904/1970 epochs mean "unset".
    const ct = parseDateString(v.creationTime);
    if (ct && ct.wall > Date.UTC(1971, 0, 1) / 1000) {
      const utc = ct.wall - (ct.offset ?? 0) * 60;
      const off = geoOffset(i.lat, i.lon, utc) ?? localOffsetAtInstant(utc * 1000);
      return { local: utc + off * 60, offset: off, source: "video" };
    }
  }

  const fn = dateFromFilename(i.name);
  if (fn != null) return { local: fn, offset: null, source: "filename" };

  if (Number.isFinite(i.mtimeMs) && i.mtimeMs > 0) {
    const utc = Math.floor(i.mtimeMs / 1000);
    const off = geoOffset(i.lat, i.lon, utc) ?? localOffsetAtInstant(i.mtimeMs);
    return { local: utc + off * 60, offset: off, source: "mtime" };
  }
  return null;
}

/**
 * Re-derives a photo's local time after its location changes (manual tag, inference, undo).
 * - Real instants (video creation_time, file mtime) were placed in the Mac's own zone when
 *   there was no location; they move into the zone at the new location.
 * - EXIF wall times stay put but gain (or lose) the offset implied by the location.
 * Everything else already knows its offset or can't be improved.
 */
export function relocalize(t: TimeResult, lat: number | null, lon: number | null): TimeResult {
  const instantBased = (t.source === "video" || t.source === "mtime") && t.offset != null;
  if (instantBased) {
    const utc = t.local - t.offset! * 60;
    const off = geoOffset(lat, lon, utc) ?? localOffsetAtInstant(utc * 1000);
    return { local: utc + off * 60, offset: off, source: t.source };
  }
  if (t.source === "exif" || t.source === "exif+geotz") {
    const off = geoOffset(lat, lon, t.local);
    return off != null ? { local: t.local, offset: off, source: "exif+geotz" } : { local: t.local, offset: null, source: "exif" };
  }
  return t;
}
