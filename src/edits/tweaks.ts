import { hasTweaks, type Tweaks } from "./model";

/**
 * The tweak pipeline, on 8-bit RGBA pixels in place. Runs in the browser for the preview
 * and on the server for saved results, so it must not depend on the image's resolution:
 * local effects (HDR, shadows, highlights, pop) read a blurred luminance map made at a
 * fixed size, and the vignette is relative to the frame.
 *
 * Order: white balance → local tone (HDR, shadows, highlights, pop) → tone curve
 * (black point, brightness, contrast) → saturation → vignette.
 */

/** Long side of the luminance maps. */
const MAP = 384;

export interface ToneMaps {
  w: number;
  h: number;
  /** Large-radius blur: the lighting of a region (HDR, shadows, highlights). */
  base: Float32Array;
  /** Small-radius blur: what pop's local contrast is measured against. */
  fine: Float32Array;
}

const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Area-averaged luminance at MAP size, so a 2048px preview and a 40MP original agree. */
export function toneMaps(data: ArrayLike<number>, w: number, h: number): ToneMaps {
  const s = Math.min(1, MAP / Math.max(w, h));
  const mw = Math.max(1, Math.round(w * s));
  const mh = Math.max(1, Math.round(h * s));
  const sum = new Float32Array(mw * mh);
  const cnt = new Float32Array(mw * mh);
  const colOf = new Int32Array(w);
  for (let x = 0; x < w; x++) colOf[x] = Math.min(mw - 1, Math.floor((x * mw) / w));
  for (let y = 0; y < h; y++) {
    const row = Math.min(mh - 1, Math.floor((y * mh) / h)) * mw;
    let p = y * w * 4;
    for (let x = 0; x < w; x++, p += 4) {
      const k = row + colOf[x]!;
      sum[k]! += luma(data[p]!, data[p + 1]!, data[p + 2]!) / 255;
      cnt[k]! += 1;
    }
  }
  for (let i = 0; i < sum.length; i++) sum[i] = cnt[i]! ? sum[i]! / cnt[i]! : 0;
  const long = Math.max(mw, mh);
  return {
    w: mw,
    h: mh,
    base: blur(sum, mw, mh, Math.max(1, Math.round(long * 0.035))),
    fine: blur(sum, mw, mh, Math.max(1, Math.round(long * 0.006))),
  };
}

/** Three box blurs ≈ a Gaussian. Edges clamp. */
function blur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  let a = Float32Array.from(src);
  let b = new Float32Array(src.length);
  for (let pass = 0; pass < 3; pass++) {
    boxH(a, b, w, h, r);
    boxV(b, a, w, h, r);
  }
  return a;
}

function boxH(src: Float32Array, dst: Float32Array, w: number, h: number, r: number) {
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += src[o + Math.min(w - 1, Math.max(0, i))]!;
    for (let x = 0; x < w; x++) {
      dst[o + x] = acc / n;
      acc += src[o + Math.min(w - 1, x + r + 1)]! - src[o + Math.max(0, x - r)]!;
    }
  }
}

function boxV(src: Float32Array, dst: Float32Array, w: number, h: number, r: number) {
  const n = 2 * r + 1;
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += src[Math.min(h - 1, Math.max(0, i)) * w + x]!;
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = acc / n;
      acc += src[Math.min(h - 1, y + r + 1) * w + x]! - src[Math.max(0, y - r) * w + x]!;
    }
  }
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

const LUT_SIZE = 4096;

/** Black point, brightness and contrast as one curve, applied to each channel. */
export function toneCurve(t: Tweaks): Float32Array {
  const bp = t.blackPoint / 100;
  const br = t.brightness / 100;
  const ct = t.contrast / 100;
  const lut = new Float32Array(LUT_SIZE);
  for (let i = 0; i < LUT_SIZE; i++) {
    let v = i / (LUT_SIZE - 1);
    // Black point: positive deepens the blacks, negative fades them.
    if (bp > 0) v = Math.max(0, (v - bp * 0.15) / (1 - bp * 0.15));
    else if (bp < 0) v = -bp * 0.15 + v * (1 + bp * 0.15);
    // Brightness lifts or lowers the midtones and leaves white and black where they are.
    if (br > 0) v = 1 - Math.pow(1 - v, 1 + br * 1.3);
    else if (br < 0) v = Math.pow(v, 1 - br * 1.3);
    // Contrast: an S-curve around the middle, or a flatter line.
    if (ct > 0) {
      const s = v < 0.5 ? 2 * v * v : 1 - 2 * (1 - v) * (1 - v);
      v += (s - v) * ct * 1.1;
    } else if (ct < 0) v = 0.5 + (v - 0.5) * (1 + ct * 0.55);
    lut[i] = Math.min(1, Math.max(0, v));
  }
  return lut;
}

export interface TweakOptions {
  /** Off while cropping: the vignette belongs to the final frame. */
  vignette?: boolean;
  /** Reuse maps of the same pixels between renders. */
  maps?: ToneMaps;
}

export function applyTweaks(
  data: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  t: Tweaks,
  opts: TweakOptions = {},
): void {
  if (!hasTweaks(t)) return;
  const local = t.hdr !== 0 || t.shadows !== 0 || t.highlights !== 0 || t.pop !== 0;
  const maps = local ? (opts.maps ?? toneMaps(data, w, h)) : null;
  const lut = toneCurve(t);
  const curve = t.blackPoint !== 0 || t.brightness !== 0 || t.contrast !== 0;

  const hdr = t.hdr / 100;
  const sh = t.shadows / 100;
  const hl = t.highlights / 100;
  const pop = t.pop / 100;
  const vig = opts.vignette === false ? 0 : t.vignette / 100;
  const sat = 1 + (t.saturation / 100) * (t.saturation > 0 ? 0.9 : 1) + hdr * 0.15 + pop * 0.12;

  // White balance as channel gains, normalised to keep the brightness.
  const warm = t.warmth / 100;
  const tint = t.tint / 100;
  let gr = (1 + warm * 0.14) * (1 + tint * 0.06);
  let gg = (1 + warm * 0.01) * (1 - tint * 0.1);
  let gb = (1 - warm * 0.14) * (1 + tint * 0.06);
  const gn = luma(gr, gg, gb);
  gr /= gn;
  gg /= gn;
  gb /= gn;
  const wb = warm !== 0 || tint !== 0;

  // Bilinear lookup into the maps: per-column indices and weights, per-row the same.
  let cx0: Int32Array | null = null;
  let cx1: Int32Array | null = null;
  let cfx: Float32Array | null = null;
  if (maps) {
    cx0 = new Int32Array(w);
    cx1 = new Int32Array(w);
    cfx = new Float32Array(w);
    for (let x = 0; x < w; x++) {
      const m = Math.min(maps.w - 1, Math.max(0, ((x + 0.5) * maps.w) / w - 0.5));
      cx0[x] = Math.floor(m);
      cx1[x] = Math.min(maps.w - 1, cx0[x]! + 1);
      cfx[x] = m - cx0[x]!;
    }
  }

  const halfW = w / 2;
  const halfH = h / 2;
  const top = LUT_SIZE - 1;

  // Per-pixel curves as tables, indexed by the region's lighting B (0..1) or the squared distance from the centre.
  const M = 1023;
  const shadowGain = new Float32Array(M + 1);
  const highMask = new Float32Array(M + 1);
  const vigMask = new Float32Array(M + 1);
  for (let i = 0; i <= M; i++) {
    const v = i / M;
    shadowGain[i] = Math.pow(2, sh * 1.3 * (1 - smooth(0, 0.55, v)));
    highMask[i] = smooth(0.45, 1, v);
    vigMask[i] = smooth(0.25, 1.05, Math.sqrt(v));
  }

  for (let y = 0; y < h; y++) {
    let r0 = 0;
    let r1 = 0;
    let fy = 0;
    if (maps) {
      const m = Math.min(maps.h - 1, Math.max(0, ((y + 0.5) * maps.h) / h - 0.5));
      const y0 = Math.floor(m);
      r0 = y0 * maps.w;
      r1 = Math.min(maps.h - 1, y0 + 1) * maps.w;
      fy = m - y0;
    }
    const dy = (y + 0.5 - halfH) / halfH;
    let p = y * w * 4;
    for (let x = 0; x < w; x++, p += 4) {
      let r = data[p]! / 255;
      let g = data[p + 1]! / 255;
      let b = data[p + 2]! / 255;

      if (wb) {
        r *= gr;
        g *= gg;
        b *= gb;
      }

      if (maps) {
        const a0 = cx0![x]!;
        const a1 = cx1![x]!;
        const fx = cfx![x]!;
        const bm = maps.base;
        const fm = maps.fine;
        const B =
          (bm[r0 + a0]! * (1 - fx) + bm[r0 + a1]! * fx) * (1 - fy) + (bm[r1 + a0]! * (1 - fx) + bm[r1 + a1]! * fx) * fy;
        const F =
          (fm[r0 + a0]! * (1 - fx) + fm[r0 + a1]! * fx) * (1 - fy) + (fm[r1 + a0]! * (1 - fx) + fm[r1 + a1]! * fx) * fy;
        const Y = luma(r, g, b);
        let Y2 = Y;
        if (hdr) {
          // Pull the lighting of each region toward the middle, then put the detail back stronger.
          const Bc = B + (0.5 - B) * 0.6 * hdr;
          Y2 = Bc + (Y - B) * (1 + 0.9 * hdr);
        }
        const bi = B <= 0 ? 0 : B >= 1 ? M : (B * M + 0.5) | 0;
        if (sh) Y2 *= shadowGain[bi]!;
        if (hl) {
          const m = highMask[bi]!;
          Y2 = hl > 0 ? Y2 + (1 - Y2) * hl * 0.5 * m : Y2 * (1 + hl * 0.45 * m);
        }
        if (pop) {
          const mid = 1 - (2 * Y - 1) * (2 * Y - 1);
          Y2 += (Y - F) * pop * 1.6 * (0.35 + 0.65 * mid);
        }
        const k = (Math.max(0, Y2) + 0.04) / (Y + 0.04);
        r *= k;
        g *= k;
        b *= k;
      }

      if (curve) {
        r = lut[r <= 0 ? 0 : r >= 1 ? top : (r * top + 0.5) | 0]!;
        g = lut[g <= 0 ? 0 : g >= 1 ? top : (g * top + 0.5) | 0]!;
        b = lut[b <= 0 ? 0 : b >= 1 ? top : (b * top + 0.5) | 0]!;
      }

      if (sat !== 1) {
        const l = luma(r, g, b);
        r = l + (r - l) * sat;
        g = l + (g - l) * sat;
        b = l + (b - l) * sat;
      }

      if (vig) {
        const dx = (x + 0.5 - halfW) / halfW;
        const r2 = (dx * dx + dy * dy) / 2;
        // Darkens toward the edges.
        const k = 1 - vig * 0.85 * vigMask[r2 >= 1 ? M : (r2 * M + 0.5) | 0]!;
        r *= k;
        g *= k;
        b *= k;
      }

      data[p] = r <= 0 ? 0 : r >= 1 ? 255 : (r * 255 + 0.5) | 0;
      data[p + 1] = g <= 0 ? 0 : g >= 1 ? 255 : (g * 255 + 0.5) | 0;
      data[p + 2] = b <= 0 ? 0 : b >= 1 ? 255 : (b * 255 + 0.5) | 0;
    }
  }
}
