import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import sharp from "sharp";
import { DATA_DIR } from "../config";
import { getThumb } from "../thumbs";
import {
  cropFits,
  editedSize,
  fitCrop,
  identity,
  isIdentity,
  noTweaks,
  parseEdits,
  presetCrop,
  serialize,
  turn,
  type Edits,
} from "./model";
import { renderEdits } from "./render";
import { applyTweaks } from "./tweaks";

describe("crop geometry", () => {
  test("the full frame fits only when straight", () => {
    const full = { x: 0, y: 0, w: 1, h: 1 };
    expect(cropFits(full, 0, 1.5)).toBe(true);
    expect(cropFits(full, 5, 1.5)).toBe(false);
  });

  test("straightening shrinks the crop about its centre until it fits, keeping its shape", () => {
    const r = fitCrop({ x: 0, y: 0, w: 1, h: 1 }, 10, 1.5);
    expect(cropFits(r, 10, 1.5)).toBe(true);
    expect(r.w / r.h).toBeCloseTo(1, 6);
    expect(r.x + r.w / 2).toBeCloseTo(0.5, 6);
    expect(r.w).toBeLessThan(1);
    expect(r.w).toBeGreaterThan(0.7);
    // And as large as it can be: a little bigger no longer fits.
    const grown = { x: r.x - 0.005, y: r.y - 0.005, w: r.w + 0.01, h: r.h + 0.01 };
    expect(cropFits(grown, 10, 1.5)).toBe(false);
  });

  test("a preset crop has the asked pixel aspect", () => {
    const r = presetCrop(1, 0, 4 / 3);
    expect((r.w * 4) / 3 / r.h).toBeCloseTo(1, 6);
    expect(r.h).toBeCloseTo(1, 6);
  });

  test("four quarter turns come back to the same crop", () => {
    let e: Edits = { ...identity(), crop: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } };
    for (let i = 0; i < 4; i++) e = turn(e, 1);
    expect(e.quarter).toBe(0);
    expect(e.crop.x).toBeCloseTo(0.1, 9);
    expect(e.crop.y).toBeCloseTo(0.2, 9);
    expect(turn(turn(e, 1), -1).crop).toEqual(e.crop);
  });

  test("edited size follows quarter turns and crop", () => {
    const e = { ...identity(), quarter: 1 as const, crop: { x: 0, y: 0, w: 0.5, h: 1 } };
    expect(editedSize(4000, 3000, e)).toEqual([1500, 4000]);
  });
});

describe("parsing", () => {
  test("round-trips and clamps", () => {
    const e = identity();
    e.tweaks.brightness = 250;
    e.tweaks.hdr = -20;
    const p = parseEdits(serialize(e))!;
    expect(p.tweaks.brightness).toBe(100);
    expect(p.tweaks.hdr).toBe(0);
    expect(parseEdits("{nope")).toBeNull();
    expect(parseEdits({ quarter: 1 })).toBeNull();
    expect(isIdentity(parseEdits(serialize(identity()))!)).toBe(true);
  });
});

describe("tweaks", () => {
  const gradient = (w: number, h: number) => {
    const d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 4;
        d[p] = (x * 255) / (w - 1);
        d[p + 1] = (y * 255) / (h - 1);
        d[p + 2] = 128;
        d[p + 3] = 255;
      }
    return d;
  };
  const mean = (d: Uint8ClampedArray) => {
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += d[i]! + d[i + 1]! + d[i + 2]!;
    return s / (d.length / 4) / 3;
  };

  test("no tweaks leave the pixels alone", () => {
    const d = gradient(32, 16);
    const before = Uint8ClampedArray.from(d);
    applyTweaks(d, 32, 16, noTweaks());
    expect(d).toEqual(before);
  });

  test("brightness, shadows and a dark vignette move the right way", () => {
    for (const [k, v, sign] of [
      ["brightness", 60, 1],
      ["brightness", -60, -1],
      ["shadows", 70, 1],
      ["vignette", -80, -1],
    ] as const) {
      const d = gradient(64, 48);
      const before = mean(d);
      applyTweaks(d, 64, 48, { ...noTweaks(), [k]: v });
      expect(Math.sign(mean(d) - before)).toBe(sign);
    }
  });

  test("local effects don't depend on resolution", () => {
    // The same picture at two sizes, tweaked, then compared at the small size.
    const t = { ...noTweaks(), hdr: 80, shadows: 50, highlights: -50, pop: 60, vignette: -40 };
    const big = gradient(800, 600);
    const small = gradient(200, 150);
    applyTweaks(big, 800, 600, t);
    applyTweaks(small, 200, 150, t);
    let diff = 0;
    for (let y = 0; y < 150; y++)
      for (let x = 0; x < 200; x++)
        for (let c = 0; c < 3; c++) {
          const a = big[((y * 4 + 2) * 800 + x * 4 + 2) * 4 + c]!;
          diff = Math.max(diff, Math.abs(a - small[(y * 200 + x) * 4 + c]!));
        }
    expect(diff).toBeLessThan(10);
  });
});

describe("rendering", () => {
  // A 400×200 picture: left half red, right half blue.
  const halves = async (path: string) => {
    const w = 400;
    const h = 200;
    const buf = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) buf[(y * w + x) * 3 + (x < w / 2 ? 0 : 2)] = 255;
    await sharp(buf, { raw: { width: w, height: h, channels: 3 } })
      .jpeg({ quality: 95 })
      .toFile(path);
  };

  test("crop keeps the chosen region", async () => {
    const path = join(DATA_DIR, "halves.jpg");
    await halves(path);
    const e = { ...identity(), crop: { x: 0.5, y: 0, w: 0.5, h: 1 } };
    const out = await renderEdits(path, e, null);
    expect([out.width, out.height]).toEqual([200, 200]);
    // All blue.
    const p = (100 * 200 + 100) * 4;
    expect(out.data[p + 2]).toBeGreaterThan(200);
    expect(out.data[p]).toBeLessThan(40);
  });

  test("a clockwise quarter turn puts the left half on top", async () => {
    const path = join(DATA_DIR, "halves-turn.jpg");
    await halves(path);
    const out = await renderEdits(path, { ...identity(), quarter: 1 }, null);
    expect([out.width, out.height]).toEqual([200, 400]);
    expect(out.data[(50 * 200 + 100) * 4]).toBeGreaterThan(200); // red on top
    expect(out.data[(350 * 200 + 100) * 4 + 2]).toBeGreaterThan(200); // blue below
  });

  test("straightened crops have no empty corners", async () => {
    const path = join(DATA_DIR, "halves-angle.jpg");
    await halves(path);
    const angle = 12;
    const out = await renderEdits(
      path,
      { ...identity(), angle, crop: fitCrop({ x: 0, y: 0, w: 1, h: 1 }, angle, 2) },
      null,
    );
    for (const [x, y] of [
      [1, 1],
      [out.width - 2, 1],
      [1, out.height - 2],
      [out.width - 2, out.height - 2],
    ] as const) {
      const p = (y * out.width + x) * 4;
      expect(Math.max(out.data[p]!, out.data[p + 2]!)).toBeGreaterThan(150);
    }
  });

  test("thumbnails of an edited photo show the edit, and the plain one is kept apart", async () => {
    const path = join(DATA_DIR, "halves-thumb.jpg");
    await halves(path);
    const e = { ...identity(), crop: { x: 0, y: 0, w: 0.25, h: 1 } };
    const src = { id: 9, path, mtime: 1, kind: "photo" as const, duration: null };
    const edited = await getThumb({ ...src, edits: serialize(e) }, "l");
    const plain = await getThumb(src, "l");
    expect(edited).not.toBe(plain);
    expect([(await sharp(edited!).metadata()).width, (await sharp(edited!).metadata()).height]).toEqual([100, 200]);
    expect((await sharp(plain!).metadata()).width).toBe(400);
  });
});
