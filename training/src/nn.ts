import { rng } from "./distort";
import { forward, type DenseLayer } from "../../src/edits/auto/model";

/**
 * Training for the tiny models: ridge regression (closed form) as a baseline, and a small MLP
 * with Adam and early stopping. The data is a few thousand rows of ~70 numbers, so plain
 * TypeScript is fast enough and keeps the project free of Python.
 */

export interface Data {
  /** Standardised features, one row per sample. */
  x: number[][];
  /** Targets, slider / 100. */
  y: number[][];
  /** Per-sample weight in the loss. */
  w: number[];
}

/** Weighted mean squared error over all outputs. */
export function loss(layers: DenseLayer[], d: Data): number {
  let s = 0;
  let ws = 0;
  for (let i = 0; i < d.x.length; i++) {
    const p = forward(layers, d.x[i]!);
    let e = 0;
    for (let j = 0; j < p.length; j++) e += (p[j]! - d.y[i]![j]!) ** 2;
    s += d.w[i]! * (e / p.length);
    ws += d.w[i]!;
  }
  return ws ? s / ws : 0;
}

/** Ridge regression as a single linear layer. */
export function ridge(d: Data, lambda: number): DenseLayer[] {
  const n = d.x[0]!.length + 1;
  const m = d.y[0]!.length;
  const A = Array.from({ length: n }, () => new Float64Array(n));
  const B = Array.from({ length: n }, () => new Float64Array(m));
  for (let r = 0; r < d.x.length; r++) {
    const xr = [...d.x[r]!, 1];
    const wr = d.w[r]!;
    for (let i = 0; i < n; i++) {
      const xi = xr[i]! * wr;
      for (let j = 0; j < n; j++) A[i]![j]! += xi * xr[j]!;
      for (let k = 0; k < m; k++) B[i]![k]! += xi * d.y[r]![k]!;
    }
  }
  // Leave the bias unpenalised.
  for (let i = 0; i < n - 1; i++) A[i]![i]! += lambda;
  const sol = solve(A, B);
  const w: number[] = [];
  const b: number[] = [];
  for (let k = 0; k < m; k++) {
    for (let i = 0; i < n - 1; i++) w.push(sol[i]![k]!);
    b.push(sol[n - 1]![k]!);
  }
  return [{ in: n - 1, out: m, w, b }];
}

/** Gaussian elimination with partial pivoting, for A·X = B. */
function solve(A: Float64Array[], B: Float64Array[]): Float64Array[] {
  const n = A.length;
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[piv]![c]!)) piv = r;
    [A[c], A[piv]] = [A[piv]!, A[c]!];
    [B[c], B[piv]] = [B[piv]!, B[c]!];
    const d = A[c]![c]! || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r]![c]! / d;
      if (!f) continue;
      for (let k = c; k < n; k++) A[r]![k]! -= f * A[c]![k]!;
      for (let k = 0; k < B[0]!.length; k++) B[r]![k]! -= f * B[c]![k]!;
    }
  }
  return B.map((row, i) => row.map((v) => v / (A[i]![i]! || 1e-12)));
}

export interface MlpOptions {
  hidden: number[];
  epochs: number;
  batch: number;
  lr: number;
  /** L2 penalty on weights. */
  decay: number;
  /** Stop after this many epochs without a better validation loss. */
  patience: number;
  seed: number;
  log?: (line: string) => void;
}

export function mlp(train: Data, val: Data, o: MlpOptions): { layers: DenseLayer[]; epochs: number; valLoss: number } {
  const rand = rng(o.seed);
  const sizes = [train.x[0]!.length, ...o.hidden, train.y[0]!.length];
  // He initialisation.
  const layers: DenseLayer[] = [];
  for (let l = 0; l < sizes.length - 1; l++) {
    const n = sizes[l]!;
    const m = sizes[l + 1]!;
    const sd = Math.sqrt(2 / n) * (l === sizes.length - 2 ? 0.1 : 1);
    const w = Array.from({ length: n * m }, () => gauss(rand) * sd);
    layers.push({ in: n, out: m, w, b: new Array(m).fill(0) });
  }
  const mW = layers.map((L) => new Float64Array(L.w.length));
  const vW = layers.map((L) => new Float64Array(L.w.length));
  const mB = layers.map((L) => new Float64Array(L.b.length));
  const vB = layers.map((L) => new Float64Array(L.b.length));
  const gW = layers.map((L) => new Float64Array(L.w.length));
  const gB = layers.map((L) => new Float64Array(L.b.length));
  const b1 = 0.9;
  const b2 = 0.999;
  let step = 0;

  let best = { layers: clone(layers), valLoss: loss(layers, val), epoch: 0 };
  const order = train.x.map((_, i) => i);
  const wSum = train.w.reduce((a, b) => a + b, 0) / train.w.length;

  for (let epoch = 1; epoch <= o.epochs; epoch++) {
    shuffle(order, rand);
    for (let s = 0; s < order.length; s += o.batch) {
      const idx = order.slice(s, s + o.batch);
      for (const g of gW) g.fill(0);
      for (const g of gB) g.fill(0);
      for (const i of idx) backprop(layers, train.x[i]!, train.y[i]!, train.w[i]! / wSum, gW, gB);
      step++;
      const lr = o.lr;
      for (let l = 0; l < layers.length; l++) {
        const L = layers[l]!;
        const k = 1 / idx.length;
        for (let j = 0; j < L.w.length; j++) {
          const g = gW[l]![j]! * k + o.decay * L.w[j]!;
          mW[l]![j] = b1 * mW[l]![j]! + (1 - b1) * g;
          vW[l]![j] = b2 * vW[l]![j]! + (1 - b2) * g * g;
          L.w[j]! -= (lr * (mW[l]![j]! / (1 - b1 ** step))) / (Math.sqrt(vW[l]![j]! / (1 - b2 ** step)) + 1e-8);
        }
        for (let j = 0; j < L.b.length; j++) {
          const g = gB[l]![j]! * k;
          mB[l]![j] = b1 * mB[l]![j]! + (1 - b1) * g;
          vB[l]![j] = b2 * vB[l]![j]! + (1 - b2) * g * g;
          L.b[j]! -= (lr * (mB[l]![j]! / (1 - b1 ** step))) / (Math.sqrt(vB[l]![j]! / (1 - b2 ** step)) + 1e-8);
        }
      }
    }
    const vl = loss(layers, val);
    if (vl < best.valLoss - 1e-7) best = { layers: clone(layers), valLoss: vl, epoch };
    if (epoch % 20 === 0) o.log?.(`  epoch ${epoch}: train ${loss(layers, train).toFixed(5)}, val ${vl.toFixed(5)}`);
    if (epoch - best.epoch >= o.patience) break;
  }
  return { layers: best.layers, epochs: best.epoch, valLoss: best.valLoss };
}

function backprop(
  layers: DenseLayer[],
  x: number[],
  y: number[],
  weight: number,
  gW: Float64Array[],
  gB: Float64Array[],
) {
  // Forward, keeping every layer's output.
  const acts: number[][] = [x];
  for (let l = 0; l < layers.length; l++) {
    const L = layers[l]!;
    const a = acts[l]!;
    const z = new Array<number>(L.out);
    for (let o = 0; o < L.out; o++) {
      let s = L.b[o]!;
      const row = o * L.in;
      for (let i = 0; i < L.in; i++) s += L.w[row + i]! * a[i]!;
      z[o] = l < layers.length - 1 ? Math.max(0, s) : s;
    }
    acts.push(z);
  }
  const out = acts[layers.length]!;
  let delta = out.map((v, j) => (2 * weight * (v - y[j]!)) / out.length);
  for (let l = layers.length - 1; l >= 0; l--) {
    const L = layers[l]!;
    const a = acts[l]!;
    const prev = new Array<number>(L.in).fill(0);
    for (let o = 0; o < L.out; o++) {
      const d = delta[o]!;
      if (!d) continue;
      gB[l]![o]! += d;
      const row = o * L.in;
      for (let i = 0; i < L.in; i++) {
        gW[l]![row + i]! += d * a[i]!;
        prev[i]! += d * L.w[row + i]!;
      }
    }
    // Through the ReLU of the layer below.
    if (l > 0) delta = prev.map((v, i) => (a[i]! > 0 ? v : 0));
  }
}

const clone = (layers: DenseLayer[]): DenseLayer[] => layers.map((L) => ({ ...L, w: [...L.w], b: [...L.b] }));

function shuffle(a: number[], rand: () => number) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
}

const gauss = (rand: () => number) => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
