import { test, expect, describe } from "bun:test";
import type { Points } from "./data";
import { buildLayout, galleryOrder, groupAt, firstVisible, GAP, HEADER_H, rowHeightFor } from "./galleryLayout";

const DAY = 86400;
/** Photos as [time, aspect, country]; NaN time = undated. Kept in index (time) order like the real data. */
function points(items: [number, number, number?][]): Points {
  const sorted = [...items].sort((a, b) => (Number.isNaN(a[0]) ? 1 : Number.isNaN(b[0]) ? -1 : a[0] - b[0]));
  const n = sorted.length;
  return {
    n,
    dated: sorted.filter(([t]) => !Number.isNaN(t)).length,
    t: Float64Array.from(sorted.map(([t]) => t)),
    lat: new Float32Array(n).fill(NaN),
    lon: new Float32Array(n).fill(NaN),
    id: Uint32Array.from(sorted.map((_, i) => i + 1)),
    kind: new Uint8Array(n),
    aspect: Float32Array.from(sorted.map(([, a]) => a)),
    country: Uint16Array.from(sorted.map(([, , c]) => c ?? 0)),
    countries: ["Russia", "Georgia"],
    source: new Uint8Array(n),
    precision: new Uint8Array(n),
  };
}

describe("buildLayout", () => {
  const W = 1000;
  const target = rowHeightFor(W);

  test("groups by day, newest first, undated last", () => {
    const p = points([[10 * DAY + 100, 1], [12 * DAY + 50, 1], [12 * DAY + 900, 1], [NaN, 1]]);
    const l = buildLayout(p, galleryOrder(p, 7), W);
    expect(l.groups.map((g) => [g.end - g.start, g.label === "Date unknown"])).toEqual([[2, false], [1, false], [1, true]]);
    // Newest photo of the newest day comes first.
    expect(p.t[l.order[0]!]).toBe(12 * DAY + 900);
  });

  test("year-only photos get their own group; dates that are only the file time go last", () => {
    const jan1 = Date.UTC(2012, 0, 1) / 1000;
    const p = points([[jan1 + 9 * 3600, 1], [jan1, 1], [jan1 + 1, 1], [Date.UTC(2026, 9, 12) / 1000, 1]]);
    // Index order is by time: [jan1 (year-only), jan1+1 (year-only), jan1+9h (real), 2026 (file time)].
    p.precision.set([2, 2, 0, 3]);
    const l = buildLayout(p, galleryOrder(p, 7), W);
    // The day's own label depends on the machine's locale; the others don't.
    expect(l.groups.map((g) => [g.label.includes("unknown") ? g.label : "day", g.end - g.start])).toEqual([
      ["day", 1],
      ["2012 · Date unknown", 2],
      ["Date unknown", 1],
    ]);
  });

  test("full rows fill the width exactly", () => {
    // Ten square photos at ~210 px don't fit in one 1000 px row.
    const p = points(Array.from({ length: 10 }, (_, i) => [5 * DAY + i, 1] as [number, number]));
    const l = buildLayout(p, galleryOrder(p, 7), W);
    const firstRowY = l.y[0]!;
    const row = [...l.order.keys()].filter((k) => l.y[k] === firstRowY);
    const last = row[row.length - 1]!;
    expect(l.x[last]! + l.w[last]!).toBeCloseTo(W, 3);
    expect(l.x[row[1]!]! - (l.x[row[0]!]! + l.w[row[0]!]!)).toBeCloseTo(GAP, 3);
  });

  test("a day's short last row keeps the target height", () => {
    const p = points([[5 * DAY, 1.5]]);
    const l = buildLayout(p, galleryOrder(p, 7), W);
    expect(l.h[0]).toBe(target);
    expect(l.w[0]).toBeCloseTo(1.5 * target, 3);
  });

  test("headers sit above their photos and list the main countries", () => {
    const p = points([[5 * DAY, 1, 1], [5 * DAY + 1, 1, 1], [5 * DAY + 2, 1, 2]]);
    const l = buildLayout(p, galleryOrder(p, 7), W);
    expect(l.groups[0]!.places).toBe("Russia · Georgia");
    expect(l.y[0]).toBe(l.groups[0]!.y + HEADER_H);
  });

  test("filters by media type", () => {
    const p = points([[5 * DAY, 1], [5 * DAY + 1, 1]]);
    p.kind[1] = 2; // video
    expect(galleryOrder(p, 1).length).toBe(1);
    expect(galleryOrder(p, 4).length).toBe(1);
  });
});

test("lookups for virtualisation", () => {
  const p = points(Array.from({ length: 40 }, (_, i) => [(i % 4) * DAY + i, 1] as [number, number]));
  const l = buildLayout(p, galleryOrder(p, 7), 1000);
  const k = firstVisible(l.y, l.h, l.order.length, 600);
  expect(l.y[k]! + l.h[k]!).toBeGreaterThanOrEqual(600);
  if (k > 0) expect(l.y[k - 1]! + l.h[k - 1]!).toBeLessThan(600);
  expect(groupAt(l.groups, l.groups[2]!.y + 5)).toBe(2);
});
