import { describe, expect, test } from "bun:test";
import { noTweaks } from "../../src/edits/model";
import { distort, sampleDistortion } from "./distort";
import { fitTweaks, render } from "./fit";
import { testImage } from "./testImage";

describe("fitting our sliders", () => {
  test("recovers tweaks it can express, close enough to look the same", () => {
    const img = testImage(96, 64, 3);
    const truth = { ...noTweaks(), brightness: 30, contrast: -20, warmth: 25, saturation: 40, shadows: 20 };
    const target = render(img, truth);
    const r = fitTweaks(img, target);
    expect(r.baseDeltaE).toBeGreaterThan(5);
    expect(r.deltaE).toBeLessThan(1);
    // The values themselves can trade off against each other; the main ones land near.
    expect(Math.abs(r.tweaks.warmth - truth.warmth)).toBeLessThanOrEqual(10);
    expect(Math.abs(r.tweaks.saturation - truth.saturation)).toBeLessThanOrEqual(15);
  });

  test("nothing to fit gives no tweaks", () => {
    const img = testImage(64, 48, 4);
    const r = fitTweaks(img, img);
    expect(r.tweaks).toEqual(noTweaks());
    expect(r.deltaE).toBe(0);
  });

  test("undoes synthetic damage most of the way", () => {
    const good = testImage(96, 64, 5);
    for (const seed of [11, 12, 13]) {
      const d = sampleDistortion(seed, 0);
      const bad = distort(good, d);
      const r = fitTweaks(bad, good);
      if (r.baseDeltaE < 2) continue;
      expect(r.deltaE).toBeLessThan(r.baseDeltaE * 0.6);
    }
  });

  test("distortions are reproducible from their seed", () => {
    expect(sampleDistortion(42)).toEqual(sampleDistortion(42));
    const img = testImage(32, 24, 6);
    expect(distort(img, sampleDistortion(7, 0)).data).toEqual(distort(img, sampleDistortion(7, 0)).data);
  });
});
