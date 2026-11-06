import { describe, expect, test } from "bun:test";
import { noTweaks } from "../../src/edits/model";
import { computeFeatures, FEATURE_NAMES } from "../../src/edits/auto/features";
import { render, type Pixels } from "./fit";
import { structure } from "./image";
import { testImage } from "./testImage";

const feature = (f: number[], name: string) => f[FEATURE_NAMES.indexOf(name)]!;

describe("features", () => {
  test("one finite value per name", () => {
    const f = computeFeatures(testImage().data, 96, 64);
    expect(f.length).toBe(FEATURE_NAMES.length);
    expect(f.every(Number.isFinite)).toBe(true);
  });

  test("move the way the image does", () => {
    const img = testImage(96, 64, 2);
    const base = computeFeatures(img.data, 96, 64);
    const bright = computeFeatures(render(img, { ...noTweaks(), brightness: 50 }).data, 96, 64);
    const warm = computeFeatures(render(img, { ...noTweaks(), warmth: 60 }).data, 96, 64);
    const dull = computeFeatures(render(img, { ...noTweaks(), saturation: -80 }).data, 96, 64);
    expect(feature(bright, "luma_p50")).toBeGreaterThan(feature(base, "luma_p50"));
    expect(feature(warm, "cast_rg_all")).toBeGreaterThan(feature(base, "cast_rg_all"));
    expect(feature(warm, "cast_bg_all")).toBeLessThan(feature(base, "cast_bg_all"));
    expect(feature(dull, "chroma_mean")).toBeLessThan(feature(base, "chroma_mean") * 0.5);
  });

  test("don't depend much on the size they're computed at", () => {
    const small = testImage(96, 64, 9);
    const big = upscale(small, 2);
    const a = computeFeatures(small.data, small.width, small.height);
    const b = computeFeatures(big.data, big.width, big.height);
    for (const name of ["luma_p50", "luma_mean", "chroma_mean", "cast_rg_all", "log_aspect"]) {
      expect(Math.abs(feature(a, name) - feature(b, name))).toBeLessThan(0.02);
    }
  });
});

describe("structure", () => {
  test("survives tone edits, not a crop", () => {
    const img = testImage(128, 96, 4);
    const edited = render(img, { ...noTweaks(), brightness: 40, contrast: 30, warmth: 30 });
    expect(structure(img, edited)).toBeGreaterThan(0.85);
    // The same frame size, but shifted by a fifth: a different picture as far as pixels go.
    const shifted = shift(img, 26, 19);
    expect(structure(img, shifted)).toBeLessThan(0.6);
  });
});

function upscale(p: Pixels, k: number): Pixels {
  const w = p.width * k;
  const h = p.height * k;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = ((Math.floor(y / k) * p.width + Math.floor(x / k)) * 4) | 0;
      data.set(p.data.subarray(s, s + 4), (y * w + x) * 4);
    }
  return { data, width: w, height: h };
}

function shift(p: Pixels, dx: number, dy: number): Pixels {
  const data = new Uint8ClampedArray(p.data.length);
  for (let y = 0; y < p.height; y++)
    for (let x = 0; x < p.width; x++) {
      const sx = Math.min(p.width - 1, x + dx);
      const sy = Math.min(p.height - 1, y + dy);
      const s = (sy * p.width + sx) * 4;
      data.set(p.data.subarray(s, s + 4), (y * p.width + x) * 4);
    }
  return { data, width: p.width, height: p.height };
}
