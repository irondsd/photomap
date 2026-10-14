import type { Points } from "./data";
import { formatDayHeader, formatYear, PRECISION } from "./data";

export const GAP = 4;
export const HEADER_H = 48;
export const GROUP_GAP = 20;
const DEFAULT_ASPECT = 4 / 3;
// Keep extreme panoramas and slivers from wrecking a row.
const MIN_ASPECT = 0.4;
const MAX_ASPECT = 3;

export interface Group {
  /** Top of the day header. */
  y: number;
  /** Tile range [start, end) in layout order. */
  start: number;
  end: number;
  /** Wall-clock time of the day's first (newest) photo; NaN for the "Date unknown" group. */
  t: number;
  label: string;
  places: string;
}

export interface Layout {
  /** Point indices in display order: newest first, undated last. */
  order: Int32Array;
  groups: Group[];
  x: Float32Array;
  y: Float32Array;
  w: Float32Array;
  h: Float32Array;
  /** Group index of each tile. */
  group: Int32Array;
  height: number;
}

export function rowHeightFor(width: number): number {
  return width < 600 ? 120 : width < 1100 ? 170 : 210;
}

const dayOf = (t: number) => Math.floor(t / 86400);
const dateless = (p: Points, i: number) => Number.isNaN(p.t[i]!) || p.precision[i] === PRECISION.unknown;

/**
 * Which header a photo goes under: its day; "2012 · Date unknown" when only the year is
 * known; or the "Date unknown" group at the very end.
 */
function groupKey(p: Points, i: number): string {
  if (dateless(p, i)) return "none";
  const t = p.t[i]!;
  return p.precision[i] === PRECISION.year ? `y${formatYear(t)}` : `d${dayOf(t)}`;
}

/** Display order: newest first, then photos without a usable date. */
export function galleryOrder(p: Points, kinds: number): Int32Array {
  const out: number[] = [];
  const tail: number[] = [];
  for (let i = p.n - 1; i >= 0; i--) {
    if (!((1 << p.kind[i]!) & kinds)) continue;
    (dateless(p, i) ? tail : out).push(i);
  }
  return Int32Array.from([...out, ...tail.reverse()]);
}

/**
 * Google-Photos-style justified rows, grouped by day. Each full row is scaled so it fills
 * `width` exactly; a day's last row keeps the target height instead of being blown up.
 */
export function buildLayout(p: Points, order: Int32Array, width: number, left = 0): Layout {
  const n = order.length;
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const w = new Float32Array(n);
  const h = new Float32Array(n);
  const group = new Int32Array(n);
  const groups: Group[] = [];
  const target = rowHeightFor(width);
  let top = 0;

  let k = 0;
  while (k < n) {
    // One day, one year of year-only photos, or the dateless tail.
    const first = order[k]!;
    const key = groupKey(p, first);
    const t0 = key === "none" ? NaN : p.t[first]!;
    let end = k + 1;
    while (end < n && groupKey(p, order[end]!) === key) end++;

    // Most photographed countries that day.
    const counts = new Map<number, number>();
    for (let j = k; j < end; j++) {
      const c = p.country[order[j]!]!;
      if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    const places = [...counts]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([c]) => p.countries[c - 1])
      .join(" · ");

    if (groups.length) top += GROUP_GAP;
    const gi = groups.length;
    const label = key === "none" ? "Date unknown" : key[0] === "y" ? `${key.slice(1)} · Date unknown` : formatDayHeader(t0);
    groups.push({ y: top, start: k, end, t: t0, label, places });
    top += HEADER_H;

    // Rows within the day.
    let rowStart = k;
    let sum = 0;
    const place = (from: number, to: number, rowH: number) => {
      let cx = left;
      for (let j = from; j < to; j++) {
        const a = aspectOf(p, order[j]!);
        x[j] = cx;
        y[j] = top;
        w[j] = a * rowH;
        h[j] = rowH;
        group[j] = gi;
        cx += a * rowH + GAP;
      }
      top += rowH + GAP;
    };
    for (let j = k; j < end; j++) {
      sum += aspectOf(p, order[j]!);
      const count = j - rowStart + 1;
      if (sum * target + GAP * (count - 1) >= width) {
        place(rowStart, j + 1, (width - GAP * (count - 1)) / sum);
        rowStart = j + 1;
        sum = 0;
      }
    }
    if (rowStart < end) {
      const count = end - rowStart;
      place(rowStart, end, Math.min(target, (width - GAP * (count - 1)) / sum));
    }
    top -= GAP;
    k = end;
  }

  return { order, groups, x, y, w, h, group, height: top };
}

function aspectOf(p: Points, i: number): number {
  const a = p.aspect[i]!;
  return Number.isFinite(a) && a > 0 ? Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, a)) : DEFAULT_ASPECT;
}

/** First index in [0, len) whose bottom edge is below `top` (tiles are in y order). */
export function firstVisible(y: Float32Array, h: Float32Array, len: number, top: number): number {
  let lo = 0;
  let hi = len;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (y[mid]! + h[mid]! < top) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Index of the group containing content offset `cy`. */
export function groupAt(groups: Group[], cy: number): number {
  let lo = 0;
  let hi = groups.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (groups[mid]!.y <= cy) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
