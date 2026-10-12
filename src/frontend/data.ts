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
}

export const KIND = { photo: 0, raw: 1, video: 2 } as const;
export const KIND_BIT = [1, 2, 4] as const;
export const ALL_KINDS = 7;

export async function loadPoints(): Promise<Points> {
  const buf = await (await fetch("/api/points")).arrayBuffer();
  const n = new Uint32Array(buf, 0, 1)[0]!;
  let off = 8;
  const t = new Float64Array(buf, off, n); off += n * 8;
  const lat = new Float32Array(buf, off, n); off += n * 4;
  const lon = new Float32Array(buf, off, n); off += n * 4;
  const id = new Uint32Array(buf, off, n); off += n * 4;
  const kind = new Uint8Array(buf, off, n);
  let dated = n;
  while (dated > 0 && Number.isNaN(t[dated - 1]!)) dated--;
  return { n, dated, t, lat, lon, id, kind };
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
