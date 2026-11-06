import { describe, expect, test } from "bun:test";
import { TWEAK_MIN, TWEAKS } from "../model";
import { applyTweaks } from "../tweaks";
import { autoTweaks, downscale } from "./index";
import { FEATURE_NAMES, FEATURE_VERSION } from "./features";
import bundled from "./model.json";
import type { AutoModel } from "./model";

/** A gradient scene with some colour and texture. */
function scene(w: number, h: number, gain = 1): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const t = ((x * 7 + y * 13) % 17) / 17;
      d[p] = (60 + 120 * (x / w) + 20 * t) * gain;
      d[p + 1] = (70 + 90 * (y / h) + 20 * t) * gain;
      d[p + 2] = (90 + 60 * (1 - y / h)) * gain;
      d[p + 3] = 255;
    }
  return d;
}

describe("auto enhance", () => {
  test("the bundled model fits the features this code computes", () => {
    const m = bundled as AutoModel;
    expect(m.featureVersion).toBe(FEATURE_VERSION);
    expect(m.features).toEqual(FEATURE_NAMES);
    expect(m.layers[0]!.in).toBe(FEATURE_NAMES.length);
    expect(m.layers.at(-1)!.out).toBe(TWEAKS.length);
  });

  test("gives whole slider values within their ranges", () => {
    const t = autoTweaks(scene(320, 240), 320, 240);
    for (const k of TWEAKS) {
      expect(Number.isInteger(t[k])).toBe(true);
      expect(t[k]).toBeGreaterThanOrEqual(TWEAK_MIN[k] ?? -100);
      expect(t[k]).toBeLessThanOrEqual(100);
      expect(t[k] === 0 || Math.abs(t[k]) >= 3).toBe(true);
    }
  });

  test("lifts a dark photo more than a well-exposed one", () => {
    const lift = (gain: number) => {
      const d = scene(320, 240, gain);
      const t = autoTweaks(d, 320, 240);
      const before = mean(d);
      applyTweaks(d, 320, 240, t);
      return mean(d) - before;
    };
    expect(lift(0.35)).toBeGreaterThan(lift(1));
  });

  test("barely depends on the preview's size", () => {
    const a = autoTweaks(scene(800, 600), 800, 600);
    const b = autoTweaks(scene(1600, 1200), 1600, 1200);
    for (const k of TWEAKS) expect(Math.abs(a[k] - b[k])).toBeLessThanOrEqual(3);
  });

  test("downscale keeps the average colour", () => {
    const d = scene(300, 200);
    const s = downscale(d, 300, 200, 64);
    expect([s.width, s.height]).toEqual([64, 43]);
    expect(Math.abs(mean(s.data) - mean(d))).toBeLessThan(1);
  });
});

function mean(d: ArrayLike<number>): number {
  let s = 0;
  for (let p = 0; p < d.length; p += 4) s += d[p]! + d[p + 1]! + d[p + 2]!;
  return s / ((d.length / 4) * 3);
}
