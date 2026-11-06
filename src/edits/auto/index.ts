import { TWEAKS, type Tweaks } from "../model";
import { computeFeatures, FEATURE_VERSION } from "./features";
import { predictTweaks, type AutoModel } from "./model";
import bundled from "./model.json";

/**
 * Auto enhance: slider values for a photo, predicted by a small model trained on Google Photos
 * edits (see training/). It sets the ordinary sliders, so the result stays adjustable.
 */

/** The long side the model's features were computed at in training. */
export const AUTO_SIZE = 256;

const MODEL = bundled as AutoModel;
if (MODEL.featureVersion !== FEATURE_VERSION) {
  throw new Error(`auto model expects features v${MODEL.featureVersion}, code computes v${FEATURE_VERSION}`);
}

/** Area-averaged copy no larger than `size` on its long side. */
export function downscale(
  data: ArrayLike<number>,
  w: number,
  h: number,
  size = AUTO_SIZE,
): { data: Uint8ClampedArray; width: number; height: number } {
  const s = Math.min(1, size / Math.max(w, h));
  const ow = Math.max(1, Math.round(w * s));
  const oh = Math.max(1, Math.round(h * s));
  const sum = new Float64Array(ow * oh * 3);
  const cnt = new Float64Array(ow * oh);
  const colOf = new Int32Array(w);
  for (let x = 0; x < w; x++) colOf[x] = Math.min(ow - 1, Math.floor((x * ow) / w));
  for (let y = 0; y < h; y++) {
    const row = Math.min(oh - 1, Math.floor((y * oh) / h)) * ow;
    for (let x = 0, p = y * w * 4; x < w; x++, p += 4) {
      const k = row + colOf[x]!;
      sum[k * 3]! += data[p]!;
      sum[k * 3 + 1]! += data[p + 1]!;
      sum[k * 3 + 2]! += data[p + 2]!;
      cnt[k]! += 1;
    }
  }
  const out = new Uint8ClampedArray(ow * oh * 4);
  for (let k = 0; k < ow * oh; k++) {
    const n = cnt[k]! || 1;
    out[k * 4] = sum[k * 3]! / n + 0.5;
    out[k * 4 + 1] = sum[k * 3 + 1]! / n + 0.5;
    out[k * 4 + 2] = sum[k * 3 + 2]! / n + 0.5;
    out[k * 4 + 3] = 255;
  }
  return { data: out, width: ow, height: oh };
}

/** Predictions this close to zero are noise: invisible, and they'd clutter the sliders. */
const MIN_CHANGE = 3;

/** Slider values that enhance this picture (8-bit RGBA, untweaked, any size). */
export function autoTweaks(data: ArrayLike<number>, w: number, h: number, model: AutoModel = MODEL): Tweaks {
  const small = downscale(data, w, h);
  const t = predictTweaks(model, computeFeatures(small.data, small.width, small.height));
  for (const k of TWEAKS) if (Math.abs(t[k]) < MIN_CHANGE) t[k] = 0;
  return t;
}
