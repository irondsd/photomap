import { describe, expect, test } from "bun:test";
import { parseEdits, identity, sameEdits, TWEAK_MIN, TWEAKS } from "./model";
import { PRESETS, presetTweaks } from "./presets";
import { applyTweaks } from "./tweaks";

function scene(w: number, h: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      d[p] = 40 + (180 * x) / w;
      d[p + 1] = 60 + (120 * y) / h;
      d[p + 2] = 200 - (120 * x) / w;
      d[p + 3] = 255;
    }
  return d;
}

describe("presets", () => {
  test("ids are unique and every value is a whole number within its slider's range", () => {
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
    for (const p of PRESETS) {
      const t = presetTweaks(p);
      for (const k of TWEAKS) {
        expect(Number.isInteger(t[k])).toBe(true);
        expect(t[k]).toBeGreaterThanOrEqual(TWEAK_MIN[k] ?? -100);
        expect(t[k]).toBeLessThanOrEqual(100);
      }
    }
  });

  test("survive saving: parsed edits keep the preset's values", () => {
    for (const p of PRESETS) {
      const e = { ...identity(), tweaks: presetTweaks(p) };
      expect(sameEdits(parseEdits(JSON.parse(JSON.stringify(e)))!, e)).toBe(true);
    }
  });

  test("each preset changes the picture, and differently from the others", () => {
    const renders = PRESETS.map((p) => {
      const d = scene(64, 48);
      applyTweaks(d, 64, 48, presetTweaks(p));
      return d.join(",");
    });
    expect(new Set([...renders, scene(64, 48).join(",")]).size).toBe(PRESETS.length + 1);
  });

  test("B&W leaves no colour", () => {
    const d = scene(64, 48);
    applyTweaks(d, 64, 48, presetTweaks(PRESETS.find((p) => p.id === "bw")!));
    for (let p = 0; p < d.length; p += 4) {
      expect(Math.abs(d[p]! - d[p + 1]!)).toBeLessThanOrEqual(1);
      expect(Math.abs(d[p + 1]! - d[p + 2]!)).toBeLessThanOrEqual(1);
    }
  });
});
