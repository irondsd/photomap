import { toneMaps } from "../tweaks";

/**
 * What the auto-enhance model sees of a photo: global statistics of tone, colour and local
 * contrast, cheap enough to compute in the browser. Training (training/) computes them on the
 * photo at 256px on its long side, so callers should too (AUTO_SIZE). Bump FEATURE_VERSION on any
 * change: stored training samples carry the version they were computed with, and the bundled
 * model must be retrained.
 */
export const FEATURE_VERSION = 1;

const LUMA_BINS = 16;
const CHROMA_BINS = 8;
const PERCENTILES = [1, 5, 10, 25, 50, 75, 90, 95, 99];

export const FEATURE_NAMES: string[] = [
  ...Array.from({ length: LUMA_BINS }, (_, i) => `luma_hist_${i}`),
  ...PERCENTILES.map((p) => `luma_p${p}`),
  "luma_mean",
  "luma_std",
  "clip_dark",
  "clip_bright",
  "clip_channel",
  "chroma_mean",
  "chroma_p50",
  "chroma_p90",
  "chroma_p99",
  ...Array.from({ length: CHROMA_BINS }, (_, i) => `chroma_hist_${i}`),
  ...["all", "shadows", "mids", "highs"].flatMap((r) => [`cast_rg_${r}`, `cast_bg_${r}`]),
  "neutral_rg",
  "neutral_bg",
  "neutral_frac",
  "detail",
  "local_contrast",
  "lighting_std",
  "lighting_p5",
  "lighting_p95",
  "centre_minus_edge",
  "top_minus_bottom",
  "skin_frac",
  "sky_frac",
  "log_aspect",
];

const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Value at percentile `p` (0..100) of a histogram over 0..1. */
function percentile(hist: Float64Array, total: number, p: number): number {
  const want = (p / 100) * total;
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i]!;
    if (acc >= want) return (i + 0.5) / hist.length;
  }
  return 1;
}

const logRatio = (a: number, b: number) => Math.log((a + 1e-3) / (b + 1e-3));

/** Features of 8-bit RGBA pixels, any size. */
export function computeFeatures(data: ArrayLike<number>, w: number, h: number): number[] {
  const n = w * h;
  const lumaHist = new Float64Array(LUMA_BINS);
  const fineLuma = new Float64Array(256);
  const chromaHist = new Float64Array(CHROMA_BINS);
  const fineChroma = new Float64Array(256);
  // Channel sums per tonal region: all, shadows (<0.25), mids, highlights (>0.75).
  const sums = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
  const neutral = [0, 0, 0, 0];
  let ySum = 0;
  let ySq = 0;
  let dark = 0;
  let bright = 0;
  let clipped = 0;
  let chromaSum = 0;
  let centre = 0;
  let centreN = 0;
  let edge = 0;
  let edgeN = 0;
  let top = 0;
  let bottom = 0;
  let third = 0;
  let skin = 0;
  let sky = 0;

  for (let y = 0; y < h; y++) {
    const inY = y > h * 0.25 && y < h * 0.75;
    const isTop = y < h / 3;
    const isBottom = y >= (2 * h) / 3;
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const R = data[p]!;
      const G = data[p + 1]!;
      const B = data[p + 2]!;
      const r = R / 255;
      const g = G / 255;
      const b = B / 255;
      const Y = luma(r, g, b);
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const c = mx - mn;
      ySum += Y;
      ySq += Y * Y;
      lumaHist[Math.min(LUMA_BINS - 1, (Y * LUMA_BINS) | 0)]!++;
      fineLuma[Math.min(255, (Y * 256) | 0)]!++;
      chromaHist[Math.min(CHROMA_BINS - 1, (c * CHROMA_BINS) | 0)]!++;
      fineChroma[Math.min(255, (c * 256) | 0)]!++;
      chromaSum += c;
      if (Y < 0.02) dark++;
      if (Y > 0.98) bright++;
      if (R >= 254 || G >= 254 || B >= 254) clipped++;
      const region = Y < 0.25 ? 1 : Y > 0.75 ? 3 : 2;
      for (const s of [sums[0]!, sums[region]!]) {
        s[0]! += r;
        s[1]! += g;
        s[2]! += b;
        s[3]! += 1;
      }
      // Nearly grey, not too dark or bright: where a cast is easiest to measure.
      if (c < 0.12 && Y > 0.15 && Y < 0.9) {
        neutral[0]! += r;
        neutral[1]! += g;
        neutral[2]! += b;
        neutral[3]! += 1;
      }
      if (inY && x > w * 0.25 && x < w * 0.75) {
        centre += Y;
        centreN++;
      } else if (!inY && (x < w * 0.1 || x > w * 0.9 || y < h * 0.1 || y > h * 0.9)) {
        edge += Y;
        edgeN++;
      }
      if (isTop) top += Y;
      if (isBottom) bottom += Y;
      if (isTop || isBottom) third++;
      // Rough skin: red over green over blue, moderately saturated, not too dark.
      if (
        r > g &&
        g > b &&
        c > 0.08 &&
        c < 0.5 &&
        Y > 0.2 &&
        (r - g) / (c + 1e-6) > 0.25 &&
        (r - g) / (c + 1e-6) < 0.75
      )
        skin++;
      // Sky-ish: blue dominant, bright, in the upper half.
      if (y < h / 2 && b > r && b >= g && Y > 0.35 && c > 0.06) sky++;
    }
  }

  const maps = toneMaps(data, w, h);
  const base = maps.base;
  const fine = maps.fine;
  // Detail: how far each map cell is from its lighting, i.e. local contrast at two scales.
  let detail = 0;
  let local = 0;
  let bSum = 0;
  let bSq = 0;
  const bHist = new Float64Array(256);
  // The maps are averages; detail against the fine map uses a downsampled luma of the same grid.
  const m = maps.w * maps.h;
  const cellLuma = new Float64Array(m);
  const cellN = new Float64Array(m);
  for (let y = 0; y < h; y++) {
    const row = Math.min(maps.h - 1, Math.floor((y * maps.h) / h)) * maps.w;
    for (let x = 0; x < w; x++) {
      const k = row + Math.min(maps.w - 1, Math.floor((x * maps.w) / w));
      const p = (y * w + x) * 4;
      cellLuma[k]! += luma(data[p]! / 255, data[p + 1]! / 255, data[p + 2]! / 255);
      cellN[k]! += 1;
    }
  }
  for (let i = 0; i < m; i++) {
    const Y = cellN[i]! ? cellLuma[i]! / cellN[i]! : 0;
    detail += Math.abs(Y - fine[i]!);
    local += Math.abs(fine[i]! - base[i]!);
    bSum += base[i]!;
    bSq += base[i]! * base[i]!;
    bHist[Math.min(255, (base[i]! * 256) | 0)]!++;
  }
  const bMean = bSum / m;

  const yMean = ySum / n;
  const cast = (s: number[]) => (s[3]! > n * 0.01 ? [logRatio(s[0]!, s[1]!), logRatio(s[2]!, s[1]!)] : [0, 0]);
  const out = [
    ...Array.from(lumaHist, (v) => v / n),
    ...PERCENTILES.map((p) => percentile(fineLuma, n, p)),
    yMean,
    Math.sqrt(Math.max(0, ySq / n - yMean * yMean)),
    dark / n,
    bright / n,
    clipped / n,
    chromaSum / n,
    percentile(fineChroma, n, 50),
    percentile(fineChroma, n, 90),
    percentile(fineChroma, n, 99),
    ...Array.from(chromaHist, (v) => v / n),
    ...sums.flatMap(cast),
    ...(neutral[3]! > n * 0.01 ? [logRatio(neutral[0]!, neutral[1]!), logRatio(neutral[2]!, neutral[1]!)] : [0, 0]),
    neutral[3]! / n,
    detail / m,
    local / m,
    Math.sqrt(Math.max(0, bSq / m - bMean * bMean)),
    percentile(bHist, m, 5),
    percentile(bHist, m, 95),
    (centreN ? centre / centreN : 0) - (edgeN ? edge / edgeN : 0),
    third ? (top - bottom) / (third / 2) : 0,
    skin / n,
    sky / n,
    Math.log(w / h),
  ];
  if (out.length !== FEATURE_NAMES.length) throw new Error("features: names out of step");
  return out;
}
