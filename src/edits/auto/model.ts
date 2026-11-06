import { noTweaks, TWEAK_MIN, TWEAKS, type TweakName, type Tweaks } from "../model";

/**
 * A trained auto-enhance model, as JSON: standardise the features, run a small fully connected
 * network (ReLU between layers, linear output), and read the outputs as slider values / 100.
 * Pure TypeScript, so the app can load model.json and predict without any runtime.
 */
export interface DenseLayer {
  in: number;
  out: number;
  /** Row-major, `out` rows of `in` weights. */
  w: number[];
  b: number[];
}

export interface AutoModel {
  version: 1;
  kind: "mlp" | "ridge";
  featureVersion: number;
  features: string[];
  mean: number[];
  std: number[];
  outputs: TweakName[];
  layers: DenseLayer[];
  trainedAt: string;
  metrics?: unknown;
}

export const OUTPUTS: TweakName[] = [...TWEAKS];

/** Raw network outputs (slider / 100) for standardised features. */
export function forward(
  layers: ArrayLike<{ in: number; out: number; w: ArrayLike<number>; b: ArrayLike<number> }>,
  x: ArrayLike<number>,
): number[] {
  let a = Array.from(x);
  for (let l = 0; l < layers.length; l++) {
    const L = layers[l]!;
    const z = new Array<number>(L.out);
    for (let o = 0; o < L.out; o++) {
      let s = L.b[o]!;
      const row = o * L.in;
      for (let i = 0; i < L.in; i++) s += L.w[row + i]! * a[i]!;
      z[o] = l < layers.length - 1 ? Math.max(0, s) : s;
    }
    a = z;
  }
  return a;
}

export const standardise = (m: Pick<AutoModel, "mean" | "std">, f: ArrayLike<number>) =>
  Array.from(f, (v, i) => (v - m.mean[i]!) / m.std[i]!);

/** Slider values for a photo's features, rounded and within range. */
export function predictTweaks(m: AutoModel, features: ArrayLike<number>): Tweaks {
  if (features.length !== m.mean.length) throw new Error("model: wrong number of features");
  const y = forward(m.layers, standardise(m, features));
  const t = noTweaks();
  m.outputs.forEach((k, i) => {
    t[k] = Math.round(Math.max(TWEAK_MIN[k] ?? -100, Math.min(100, y[i]! * 100)));
  });
  return t;
}
