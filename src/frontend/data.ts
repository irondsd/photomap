/** Column-oriented photo index, sorted by time ascending (undated at the end). */
export interface Points {
  n: number;
  /** Number of dated photos; indices [0, dated) have finite t. */
  dated: number;
  t: Float64Array;
  lat: Float32Array;
  lon: Float32Array;
  id: Uint32Array;
  kind: Uint8Array;
  /** Width / height as displayed; NaN when unknown. */
  aspect: Float32Array;
  /** 0 = none, otherwise 1 + index into `countries`. */
  country: Uint16Array;
  countries: string[];
  /** Where the location came from; see SOURCE. */
  source: Uint8Array;
}

export const SOURCE = { none: 0, file: 1, inferred: 2, manual: 3 } as const;

export const KIND = { photo: 0, raw: 1, video: 2 } as const;
export const KIND_BIT = [1, 2, 4] as const;
export const ALL_KINDS = 7;

export async function loadPoints(): Promise<Points> {
  // Layout: see encodePoints in server.ts.
  const buf = await (await fetch("/api/points")).arrayBuffer();
  const [n, jsonBytes] = new Uint32Array(buf, 0, 2) as unknown as [number, number];
  const countries = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, jsonBytes))) as string[];
  let off = 8 + Math.ceil(jsonBytes / 8) * 8;
  const col = <T>(make: new (b: ArrayBuffer, o: number, l: number) => T, bytes: number): T => {
    const a = new make(buf, off, n);
    off += n * bytes;
    return a;
  };
  const t = col(Float64Array, 8);
  const lat = col(Float32Array, 4);
  const lon = col(Float32Array, 4);
  const aspect = col(Float32Array, 4);
  const id = col(Uint32Array, 4);
  const country = col(Uint16Array, 2);
  const kind = col(Uint8Array, 1);
  const source = col(Uint8Array, 1);
  let dated = n;
  while (dated > 0 && Number.isNaN(t[dated - 1]!)) dated--;
  return { n, dated, t, lat, lon, id, kind, aspect, country, countries, source };
}

/** First index with t >= x, within the dated prefix. */
export function lowerBound(t: Float64Array, dated: number, x: number): number {
  let lo = 0;
  let hi = dated;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (t[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export type Range = [number, number];

export function inRange(t: number, r: Range | null): boolean {
  return !r || (t >= r[0] && t < r[1]);
}

export type BBox = [west: number, south: number, east: number, north: number];

export function inBBox(lat: number, lon: number, b: BBox): boolean {
  if (lat < b[1] || lat > b[3]) return false;
  return b[0] <= b[2] ? lon >= b[0] && lon <= b[2] : lon >= b[0] || lon <= b[2];
}

// ---------------------------------------------------------------- calendar units (wall-clock seconds, read as UTC)

export type Unit = "year" | "month" | "week" | "day" | "hour";

export const APPROX: Record<Unit, number> = {
  year: 365.25 * 86400,
  month: 30.44 * 86400,
  week: 7 * 86400,
  day: 86400,
  hour: 3600,
};

export function floorTo(t: number, unit: Unit, step = 1): number {
  const d = new Date(t * 1000);
  switch (unit) {
    case "year": {
      const y = d.getUTCFullYear();
      return Date.UTC(y - (((y % step) + step) % step), 0, 1) / 1000;
    }
    case "month": {
      const m = d.getUTCMonth();
      return Date.UTC(d.getUTCFullYear(), m - (m % step), 1) / 1000;
    }
    case "week": {
      // Weeks start on Monday.
      const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
      const dow = (d.getUTCDay() + 6) % 7;
      return day - dow * 86400;
    }
    case "day": {
      const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
      if (step === 1) return day;
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDate() - 1) % step)) / 1000;
    }
    case "hour":
      return Math.floor(t / (3600 * step)) * 3600 * step;
  }
}

export function addUnit(t: number, unit: Unit, n = 1): number {
  const d = new Date(t * 1000);
  switch (unit) {
    case "year":
      return Date.UTC(d.getUTCFullYear() + n, d.getUTCMonth(), d.getUTCDate(), d.getUTCHours()) / 1000;
    case "month":
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, d.getUTCDate(), d.getUTCHours()) / 1000;
    case "week":
      return t + n * 7 * 86400;
    case "day":
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n, d.getUTCHours(), d.getUTCMinutes()) / 1000;
    case "hour":
      return t + n * 3600;
  }
}

// ---------------------------------------------------------------- formatting

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(opts);
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(undefined, { ...opts, timeZone: "UTC" });
    fmtCache.set(key, f);
  }
  return f;
}

export const formatDate = (t: number) => fmt({ year: "numeric", month: "short", day: "numeric" }).format(t * 1000);
export const formatDateTime = (t: number) =>
  fmt({ year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(t * 1000);
export const formatMonth = (t: number) => fmt({ year: "numeric", month: "short" }).format(t * 1000);
export const formatDayHeader = (t: number) => fmt({ weekday: "short", year: "numeric", month: "short", day: "numeric" }).format(t * 1000);
export const formatMonthShort = (t: number) => fmt({ month: "short" }).format(t * 1000);
export const formatDayShort = (t: number) => fmt({ month: "short", day: "numeric" }).format(t * 1000);
export const formatHour = (t: number) => fmt({ hour: "2-digit", minute: "2-digit" }).format(t * 1000);
export const formatYear = (t: number) => String(new Date(t * 1000).getUTCFullYear());

export function formatRange(r: Range): string {
  const a = r[0];
  const b = r[1] - 1; // ranges are half-open
  if (b - a < 86400 && formatDate(a) === formatDate(b)) return `${formatDate(a)}, ${formatHour(a)}–${formatHour(r[1])}`;
  return `${formatDate(a)} – ${formatDate(b)}`;
}

export function formatOffset(min: number | null): string {
  if (min == null) return "";
  const sign = min >= 0 ? "+" : "−";
  const a = Math.abs(min);
  return `UTC${sign}${Math.floor(a / 60)}${a % 60 ? ":" + String(a % 60).padStart(2, "0") : ""}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function formatExposure(s: number | null): string | null {
  if (s == null) return null;
  if (s >= 1) return `${+s.toFixed(1)}s`;
  return `1/${Math.round(1 / s)}s`;
}

export const nf = new Intl.NumberFormat();

// ---------------------------------------------------------------- hints

function formatGap(seconds: number) {
  const m = Math.abs(seconds) / 60;
  if (m < 1) return "a few seconds";
  if (m < 90) return `${Math.round(m)} min`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h`;
  return `${Math.round(m / 1440)} days`;
}

/**
 * The geotagged photo closest in time to point i, as a starting point for placing it.
 * `skip` excludes photos whose location is being replaced (e.g. the rest of a selection).
 */
export function nearestTagged(points: Points, i: number, skip?: (j: number) => boolean): { at: { lat: number; lon: number }; label: string } | null {
  const t = points.t[i]!;
  if (Number.isNaN(t)) return null;
  let best = -1;
  for (const dir of [-1, 1]) {
    for (let j = i + dir; j >= 0 && j < points.dated; j += dir) {
      if (Number.isNaN(points.lat[j]!) || skip?.(j)) continue;
      if (best < 0 || Math.abs(points.t[j]! - t) < Math.abs(points.t[best]! - t)) best = j;
      break;
    }
  }
  if (best < 0) return null;
  const dt = points.t[best]! - t;
  // Further apart than this, where you were then says nothing about this photo.
  if (Math.abs(dt) > 30 * 86400) return null;
  return {
    at: { lat: points.lat[best]!, lon: points.lon[best]! },
    label: `where your photo from ${formatGap(dt)} ${dt < 0 ? "earlier" : "later"} was taken`,
  };
}
