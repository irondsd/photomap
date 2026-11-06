/**
 * CIELAB distances between 8-bit sRGB images, so a fit's error reads in visual units:
 * a mean ΔE of about 1 is at the edge of what people notice, 5 is a clear difference.
 */

const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

/** L, a, b for every pixel of RGBA data. */
export function toLab(data: ArrayLike<number>, n: number): Float32Array {
  const out = new Float32Array(n * 3);
  for (let i = 0, p = 0; i < n; i++, p += 4) labAt(data, p, out, i * 3);
  return out;
}

function labAt(data: ArrayLike<number>, p: number, out: Float32Array, o: number) {
  const r = LIN[data[p]!]!;
  const g = LIN[data[p + 1]!]!;
  const b = LIN[data[p + 2]!]!;
  const fx = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const fy = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const fz = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  out[o] = 116 * fy - 16;
  out[o + 1] = 500 * (fx - fy);
  out[o + 2] = 200 * (fy - fz);
}

const tmp = new Float32Array(3);

/** Mean CIE76 ΔE of RGBA `data` against precomputed Lab values. */
export function meanDeltaE(lab: Float32Array, data: ArrayLike<number>, n: number): number {
  let sum = 0;
  for (let i = 0, p = 0, o = 0; i < n; i++, p += 4, o += 3) {
    labAt(data, p, tmp, 0);
    const dl = tmp[0]! - lab[o]!;
    const da = tmp[1]! - lab[o + 1]!;
    const db = tmp[2]! - lab[o + 2]!;
    sum += Math.sqrt(dl * dl + da * da + db * db);
  }
  return sum / n;
}
