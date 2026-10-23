import { test, expect, describe } from "bun:test";
import { clampPan, fitSize, IDENTITY, maxScale, placement, zoomAt } from "./zoom";

describe("zoomAt", () => {
  test("keeps the point under the cursor still", () => {
    const p = { x: 120, y: -40 };
    const v = zoomAt(IDENTITY, 3, p);
    // Image point under p before: (p - t) / s; after it must map back to p.
    const q = { x: (p.x - IDENTITY.x) / IDENTITY.s, y: (p.y - IDENTITY.y) / IDENTITY.s };
    expect(v.x + v.s * q.x).toBeCloseTo(p.x);
    expect(v.y + v.s * q.y).toBeCloseTo(p.y);
  });

  test("zooming back out to 1 about the same point undoes it", () => {
    const p = { x: 50, y: 70 };
    const v = zoomAt(zoomAt(IDENTITY, 2.5, p), 1, p);
    expect(v.s).toBe(1);
    expect(v.x).toBeCloseTo(0);
    expect(v.y).toBeCloseTo(0);
  });

  test("about the centre only scales", () => {
    expect(zoomAt({ s: 2, x: 10, y: -6 }, 4, { x: 0, y: 0 })).toEqual({ s: 4, x: 20, y: -12 });
  });
});

describe("clampPan", () => {
  const stage = { w: 1000, h: 800 };
  const img = { w: 1000, h: 600 };

  test("no pan at 1×", () => {
    expect(clampPan({ s: 1, x: 300, y: -200 }, img, stage)).toEqual({ s: 1, x: 0, y: 0 });
  });

  test("stops at the image edges", () => {
    // 2×: 2000×1200 in a 1000×800 stage → ±500 across, ±200 down.
    expect(clampPan({ s: 2, x: 900, y: -900 }, img, stage)).toEqual({ s: 2, x: 500, y: -200 });
  });

  test("a side that still fits stays centred", () => {
    // 1.2×: 1200×720 — wider than the stage, not taller.
    expect(clampPan({ s: 1.2, x: 50, y: 50 }, img, stage)).toEqual({ s: 1.2, x: 50, y: 0 });
  });
});

describe("maxScale", () => {
  test("enough to see the original's pixels at 2×", () => {
    expect(maxScale(4080, { w: 1240, h: 934 })).toBeCloseTo((2 * 4080) / 1240);
  });

  test("at least 4×, also with no size known", () => {
    expect(maxScale(1000, { w: 1000, h: 750 })).toBe(4);
    expect(maxScale(null, { w: 1000, h: 750 })).toBe(4);
  });
});

describe("fitSize", () => {
  const stage = { w: 1200, h: 900 };

  test("fits a big image inside the stage", () => {
    expect(fitSize({ w: 2048, h: 1536 }, stage, 4080)).toEqual({ w: 1200, h: 900 });
    expect(fitSize({ w: 1536, h: 2048 }, stage, 4080)).toEqual({ w: 675, h: 900 });
  });

  test("doesn't enlarge a small image past its own pixels", () => {
    expect(fitSize({ w: 640, h: 480 }, stage, 640)).toEqual({ w: 640, h: 480 });
    expect(fitSize({ w: 640, h: 480 }, stage, null)).toEqual({ w: 640, h: 480 });
  });

  test("the preview and the original come out the same size", () => {
    const wide = { w: 3000, h: 1400 };
    const preview = fitSize({ w: 2048, h: 1536 }, wide, 4080);
    const original = fitSize({ w: 4080, h: 3060 }, wide, 4080);
    expect(preview.w).toBeCloseTo(original.w);
    expect(preview.h).toBeCloseTo(original.h);
  });
});

describe("placement", () => {
  test("centred at 1×", () => {
    expect(placement(IDENTITY, { w: 800, h: 600 }, { w: 1000, h: 600 }, 2)).toEqual({
      w: 800,
      h: 600,
      left: 100,
      top: 0,
    });
  });

  test("snaps to device pixels", () => {
    const p = placement({ s: 1.333, x: 10.3, y: -7.77 }, { w: 800, h: 600 }, { w: 1000, h: 600 }, 2);
    for (const n of Object.values(p)) expect(Number.isInteger(n * 2)).toBe(true);
  });
});
