import type { Pixels } from "./fit";
import { rng } from "./distort";

/**
 * A small photo-like test image: a sky gradient over darker ground, a few coloured objects,
 * a skin-toned patch and fine texture, so every slider has something to act on.
 */
export function testImage(w = 96, h = 64, seed = 1): Pixels {
  const rand = rng(seed);
  const data = new Uint8ClampedArray(w * h * 4);
  const blobs = Array.from({ length: 5 }, () => ({
    x: rand() * w,
    y: h * (0.4 + rand() * 0.6),
    r: 6 + rand() * 12,
    c: [rand(), rand(), rand()] as const,
  }));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = y / h;
      let r: number, g: number, b: number;
      if (v < 0.45) {
        r = 0.45 + v * 0.5;
        g = 0.6 + v * 0.4;
        b = 0.9 - v * 0.2;
      } else {
        r = 0.32 - (v - 0.45) * 0.3;
        g = 0.28 - (v - 0.45) * 0.25;
        b = 0.18 - (v - 0.45) * 0.15;
      }
      for (const o of blobs) {
        if ((x - o.x) ** 2 + (y - o.y) ** 2 < o.r * o.r) [r, g, b] = o.c;
      }
      if (x > w * 0.7 && x < w * 0.85 && y > h * 0.2 && y < h * 0.4) [r, g, b] = [0.85, 0.62, 0.5];
      const n = (rand() - 0.5) * 0.06;
      const p = (y * w + x) * 4;
      data[p] = (r + n) * 255;
      data[p + 1] = (g + n) * 255;
      data[p + 2] = (b + n) * 255;
      data[p + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}
