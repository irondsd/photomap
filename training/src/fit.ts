import { noTweaks, TWEAK_MIN, TWEAKS, type TweakName, type Tweaks } from "../../src/edits/model";
import { applyTweaks, toneMaps } from "../../src/edits/tweaks";
import { meanDeltaE, toLab } from "./color";

/** 8-bit RGBA, like the editor's canvas. */
export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface FitOptions {
  /**
   * Cost of a slider, in ΔE per 100 points. Several sliders can do the same thing (brightness,
   * shadows and HDR all lift a dark photo); this picks the fewest and smallest, so similar photos
   * get similar labels and a model can learn them.
   */
  lambda?: number;
  /** Step sizes tried, largest first. */
  steps?: number[];
  /** Start from these values instead of zero. */
  start?: Partial<Tweaks>;
}

export interface FitResult {
  tweaks: Tweaks;
  /** Mean ΔE after the fitted tweaks. */
  deltaE: number;
  /** Mean ΔE with no tweaks: how far apart the two images were. */
  baseDeltaE: number;
  evals: number;
}

/** Most influential first, so the large steps settle the overall tone before the details. */
const ORDER: TweakName[] = [
  "brightness",
  "contrast",
  "blackPoint",
  "warmth",
  "tint",
  "saturation",
  "shadows",
  "highlights",
  "hdr",
  "pop",
  "vignette",
];

/** Renders `input` with tweaks, the way the editor does. */
export function render(input: Pixels, t: Tweaks, maps = toneMaps(input.data, input.width, input.height)): Pixels {
  const data = new Uint8ClampedArray(input.data);
  applyTweaks(data, input.width, input.height, t, { maps });
  return { data, width: input.width, height: input.height };
}

/**
 * The slider values that make our renderer turn `input` into something as close to `target` as
 * it can, by coordinate descent over whole slider points. Both images must be the same size.
 */
export function fitTweaks(input: Pixels, target: Pixels, opts: FitOptions = {}): FitResult {
  const { width: w, height: h } = input;
  if (target.width !== w || target.height !== h) throw new Error("fit: images differ in size");
  const lambda = (opts.lambda ?? 0.5) / 100;
  const steps = opts.steps ?? [32, 16, 8, 4, 2, 1];
  const n = w * h;
  const lab = toLab(target.data, n);
  // The maps only read the input, so one set serves every trial.
  const maps = toneMaps(input.data, w, h);
  const scratch = new Uint8ClampedArray(input.data.length);
  let evals = 0;

  const error = (t: Tweaks) => {
    evals++;
    scratch.set(input.data);
    applyTweaks(scratch, w, h, t, { maps });
    return meanDeltaE(lab, scratch, n);
  };
  const cost = (t: Tweaks, e: number) => e + lambda * TWEAKS.reduce((s, k) => s + Math.abs(t[k]), 0);

  const cur = { ...noTweaks(), ...opts.start };
  const baseDeltaE = error(noTweaks());
  let curErr = opts.start ? error(cur) : baseDeltaE;
  let curCost = cost(cur, curErr);

  for (const step of steps) {
    for (let pass = 0; pass < 6; pass++) {
      let improved = false;
      for (const k of ORDER) {
        const lo = TWEAK_MIN[k] ?? -100;
        const v0 = cur[k];
        let best = v0;
        for (const dir of [1, -1]) {
          // Keep walking while it helps: a slider far from its value would otherwise take many passes.
          let v = v0;
          for (;;) {
            const next = Math.max(lo, Math.min(100, v + dir * step));
            if (next === v) break;
            cur[k] = next;
            const e = error(cur);
            const c = cost(cur, e);
            if (c < curCost - 1e-6) {
              curCost = c;
              curErr = e;
              best = v = next;
              improved = true;
            } else break;
          }
          cur[k] = best;
          if (best !== v0) break;
        }
      }
      if (!improved) break;
    }
  }
  return { tweaks: cur, deltaE: curErr, baseDeltaE, evals };
}
