import type { Pixels } from "./fit";

/**
 * Synthetic "before" images for distort-and-recover: a good photo made worse the way real
 * photos go wrong, in linear light: under- or overexposed, a colour cast, flat and hazy, dull.
 * Seeded, so a sample can be rebuilt from its record instead of stored.
 */

export interface Distortion {
  seed: number;
  /** Exposure, in stops. */
  ev: number;
  /** Warm/cool and green/magenta casts, as log channel gains. */
  temp: number;
  tint: number;
  /** Contrast around the middle (1 = unchanged), applied to display values. */
  contrast: number;
  /** Lifted blacks, 0..1 of the range. */
  lift: number;
  /** Gamma on display values: above 1 darkens the midtones. */
  gamma: number;
  /** Saturation multiplier. */
  saturation: number;
}

/** mulberry32: small, fast, good enough for sampling. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal from two uniforms. */
const normal = (rand: () => number) => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const NONE: Omit<Distortion, "seed"> = {
  ev: 0,
  temp: 0,
  tint: 0,
  contrast: 1,
  lift: 0,
  gamma: 1,
  saturation: 1,
};

/**
 * Random distortion. Each kind of damage shows up in about half the samples, and some samples
 * stay untouched, so the model also learns to leave a good photo alone.
 */
export function sampleDistortion(seed: number, untouched = 0.12): Distortion {
  const rand = rng(seed);
  if (rand() < untouched) return { seed, ...NONE };
  const some = (p: number, f: () => number, none: number) => (rand() < p ? f() : none);
  return {
    seed,
    // Underexposure is far more common than overexposure.
    ev: some(0.6, () => clamp(normal(rand) * 0.55 - 0.25, -1.6, 0.9), 0),
    temp: some(0.5, () => clamp(normal(rand) * 0.09, -0.25, 0.25), 0),
    tint: some(0.3, () => clamp(normal(rand) * 0.04, -0.12, 0.12), 0),
    contrast: some(0.5, () => 0.6 + rand() * 0.5, 1),
    lift: some(0.3, () => rand() * 0.08, 0),
    gamma: some(0.3, () => Math.exp(clamp(normal(rand) * 0.15, -0.35, 0.35)), 1),
    saturation: some(0.5, () => 0.55 + rand() * 0.6, 1),
  };
}

const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const encode = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

/** The distorted copy of `img`. */
export function distort(img: Pixels, d: Distortion): Pixels {
  const out = new Uint8ClampedArray(img.data.length);
  const gain = Math.pow(2, d.ev);
  const gr = gain * Math.exp(d.temp + d.tint * 0.5);
  const gg = gain * Math.exp(-d.tint);
  const gb = gain * Math.exp(-d.temp + d.tint * 0.5);
  const src = img.data;
  for (let p = 0; p < src.length; p += 4) {
    let r = encode(clamp(LIN[src[p]!]! * gr, 0, 1));
    let g = encode(clamp(LIN[src[p + 1]!]! * gg, 0, 1));
    let b = encode(clamp(LIN[src[p + 2]!]! * gb, 0, 1));
    if (d.gamma !== 1) {
      r = Math.pow(r, d.gamma);
      g = Math.pow(g, d.gamma);
      b = Math.pow(b, d.gamma);
    }
    if (d.contrast !== 1) {
      r = 0.5 + (r - 0.5) * d.contrast;
      g = 0.5 + (g - 0.5) * d.contrast;
      b = 0.5 + (b - 0.5) * d.contrast;
    }
    if (d.lift) {
      r = d.lift + r * (1 - d.lift);
      g = d.lift + g * (1 - d.lift);
      b = d.lift + b * (1 - d.lift);
    }
    if (d.saturation !== 1) {
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = l + (r - l) * d.saturation;
      g = l + (g - l) * d.saturation;
      b = l + (b - l) * d.saturation;
    }
    out[p] = r * 255 + 0.5;
    out[p + 1] = g * 255 + 0.5;
    out[p + 2] = b * 255 + 0.5;
    out[p + 3] = 255;
  }
  return { data: out, width: img.width, height: img.height };
}
