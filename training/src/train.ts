import { TWEAKS, type Tweaks } from "../../src/edits/model";
import { toneMaps } from "../../src/edits/tweaks";
import { meanDeltaE, toLab } from "./color";
import { isVal, samplePixels, type Sample } from "./dataset";
import { FEATURE_NAMES, FEATURE_VERSION } from "../../src/edits/auto/features";
import { render } from "./fit";
import type { ImageCache } from "./image";
import { OUTPUTS, predictTweaks, type AutoModel } from "../../src/edits/auto/model";
import { loss, mlp, ridge, type Data } from "./nn";

export interface TrainOptions {
  samples: Sample[];
  cache: ImageCache;
  /** Pairs whose fit stays further than this (mean ΔE) are edits our sliders can't express. */
  maxFit: number;
  /** Weight of a real pair against a synthetic sample in the loss. */
  pairWeight: number;
  useSynthetic: boolean;
  hidden: number[];
  epochs: number;
  /** Validation samples rendered for the image-space comparison. */
  evalLimit: number;
  log: (line: string) => void;
}

export interface ImageScore {
  n: number;
  /** Mean ΔE to the target: doing nothing, the fitted labels (the best our sliders can do), each model. */
  none: number;
  fitted: number;
  models: Record<string, number>;
}

export interface Metrics {
  counts: { train: number; val: number; trainPairs: number; valPairs: number; skippedPairs: number };
  /** Mean absolute error per slider on validation, in slider points. */
  sliderMae: Record<string, Record<string, number>>;
  image: { pair?: ImageScore; synthetic?: ImageScore };
  chosen: string;
}

export function usable(s: Sample, maxFit: number): boolean {
  if (s.featureVersion !== FEATURE_VERSION) return false;
  if (s.kind === "synthetic") return true;
  return s.deltaE <= maxFit && s.deltaE < s.baseDeltaE;
}

function stats(rows: number[][]) {
  const n = rows[0]!.length;
  const mean = new Array<number>(n).fill(0);
  const std = new Array<number>(n).fill(0);
  for (const r of rows) for (let i = 0; i < n; i++) mean[i]! += r[i]! / rows.length;
  for (const r of rows) for (let i = 0; i < n; i++) std[i]! += (r[i]! - mean[i]!) ** 2 / rows.length;
  return { mean, std: std.map((v) => Math.sqrt(v) || 1) };
}

const toData = (rows: Sample[], st: { mean: number[]; std: number[] }, pairWeight: number): Data => ({
  x: rows.map((s) => s.features.map((v, i) => (v - st.mean[i]!) / st.std[i]!)),
  y: rows.map((s) => OUTPUTS.map((k) => s.tweaks[k] / 100)),
  w: rows.map((s) => (s.kind === "pair" ? pairWeight : 1)),
});

function mae(m: AutoModel, rows: Sample[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of TWEAKS) out[k] = 0;
  for (const s of rows) {
    const p = predictTweaks(m, s.features);
    for (const k of TWEAKS) out[k]! += Math.abs(p[k] - s.tweaks[k]) / rows.length;
  }
  for (const k of TWEAKS) out[k] = Math.round(out[k]! * 10) / 10;
  return out;
}

/** Mean ΔE between each rendered prediction and its target. */
async function imageScore(
  models: Record<string, AutoModel>,
  rows: Sample[],
  cache: ImageCache,
): Promise<ImageScore | undefined> {
  const score: ImageScore = {
    n: 0,
    none: 0,
    fitted: 0,
    models: Object.fromEntries(Object.keys(models).map((k) => [k, 0])),
  };
  for (const s of rows) {
    const px = await samplePixels(s, cache);
    if (!px) continue;
    const n = px.target.width * px.target.height;
    const lab = toLab(px.target.data, n);
    const maps = toneMaps(px.input.data, px.input.width, px.input.height);
    const de = (t: Tweaks) => meanDeltaE(lab, render(px.input, t, maps).data, n);
    score.n++;
    score.none += meanDeltaE(lab, px.input.data, n);
    score.fitted += s.deltaE;
    for (const [name, m] of Object.entries(models)) score.models[name]! += de(predictTweaks(m, s.features));
  }
  if (!score.n) return undefined;
  const r = (v: number) => Math.round((v / score.n) * 100) / 100;
  return {
    n: score.n,
    none: r(score.none),
    fitted: r(score.fitted),
    models: Object.fromEntries(Object.entries(score.models).map(([k, v]) => [k, r(v)])),
  };
}

export async function train(o: TrainOptions): Promise<{ model: AutoModel; metrics: Metrics }> {
  const all = o.samples.filter((s) => o.useSynthetic || s.kind === "pair");
  const rows = all.filter((s) => usable(s, o.maxFit));
  const skippedPairs = all.filter((s) => s.kind === "pair").length - rows.filter((s) => s.kind === "pair").length;
  const trainRows = rows.filter((s) => !isVal(s.group));
  const valRows = rows.filter((s) => isVal(s.group));
  if (trainRows.length < 20 || valRows.length < 5)
    throw new Error(`too few samples (${trainRows.length} train, ${valRows.length} validation)`);
  o.log(
    `${trainRows.length} train / ${valRows.length} validation samples` +
      ` (${trainRows.filter((s) => s.kind === "pair").length} / ${valRows.filter((s) => s.kind === "pair").length} pairs, ${skippedPairs} pairs skipped by fit)`,
  );

  const st = stats(trainRows.map((s) => s.features));
  const tr = toData(trainRows, st, o.pairWeight);
  const va = toData(valRows, st, o.pairWeight);
  const wrap = (kind: AutoModel["kind"], layers: AutoModel["layers"]): AutoModel => ({
    version: 1,
    kind,
    featureVersion: FEATURE_VERSION,
    features: FEATURE_NAMES,
    mean: st.mean,
    std: st.std,
    outputs: OUTPUTS,
    layers,
    trainedAt: new Date().toISOString(),
  });

  // Ridge: pick the penalty on validation.
  let bestRidge = { lambda: 0, layers: ridge(tr, 1), loss: Infinity };
  for (const lambda of [0.1, 1, 10, 100, 1000]) {
    const layers = ridge(tr, lambda);
    const l = loss(layers, va);
    if (l < bestRidge.loss) bestRidge = { lambda, layers, loss: l };
  }
  o.log(`ridge: λ=${bestRidge.lambda}, validation loss ${bestRidge.loss.toFixed(5)}`);

  o.log(`mlp ${[FEATURE_NAMES.length, ...o.hidden, OUTPUTS.length].join("→")}:`);
  const net = mlp(tr, va, {
    hidden: o.hidden,
    epochs: o.epochs,
    batch: 64,
    lr: 1e-3,
    decay: 1e-4,
    patience: 60,
    seed: 1,
    log: o.log,
  });
  o.log(`mlp: best at epoch ${net.epochs}, validation loss ${net.valLoss.toFixed(5)}`);

  const models = { ridge: wrap("ridge", bestRidge.layers), mlp: wrap("mlp", net.layers) };
  const pick = (kind: Sample["kind"]) => {
    const v = valRows.filter((s) => s.kind === kind);
    return v.slice(0, o.evalLimit);
  };
  o.log("rendering validation samples…");
  const image = {
    pair: await imageScore(models, pick("pair"), o.cache),
    synthetic: await imageScore(models, pick("synthetic"), o.cache),
  };
  // Real pairs are what Auto is for; synthetic only decides when there are none.
  const judge = image.pair ?? image.synthetic;
  const chosen = judge && judge.models.ridge! < judge.models.mlp! ? "ridge" : "mlp";
  const metrics: Metrics = {
    counts: {
      train: trainRows.length,
      val: valRows.length,
      trainPairs: trainRows.filter((s) => s.kind === "pair").length,
      valPairs: valRows.filter((s) => s.kind === "pair").length,
      skippedPairs,
    },
    sliderMae: { ridge: mae(models.ridge, valRows), mlp: mae(models.mlp, valRows) },
    image,
    chosen,
  };
  const model = { ...models[chosen], metrics };
  return { model, metrics };
}
