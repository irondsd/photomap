import { describe, expect, test } from "bun:test";
import { rng } from "./distort";
import { forward } from "../../src/edits/auto/model";
import { loss, mlp, ridge, type Data } from "./nn";

function data(n: number, seed: number, f: (x: number[]) => number[]): Data {
  const rand = rng(seed);
  const x = Array.from({ length: n }, () => [rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1]);
  return { x, y: x.map(f), w: x.map(() => 1) };
}

describe("tiny models", () => {
  test("ridge recovers a linear map", () => {
    const d = data(200, 1, ([a, b, c]) => [0.5 * a! - 0.2 * c! + 0.1, b!]);
    const layers = ridge(d, 1e-6);
    const p = forward(layers, [0.4, -0.3, 0.2]);
    expect(p[0]!).toBeCloseTo(0.5 * 0.4 - 0.2 * 0.2 + 0.1, 4);
    expect(p[1]!).toBeCloseTo(-0.3, 4);
  });

  test("the MLP learns what a line can't", () => {
    const f = ([a, b]: number[]) => [Math.abs(a!) * 0.5 + Math.max(0, b!) * 0.3];
    const train = data(600, 2, f);
    const val = data(150, 3, f);
    const lin = loss(ridge(train, 1e-3), val);
    const net = mlp(train, val, { hidden: [24], epochs: 150, batch: 32, lr: 0.01, decay: 0, patience: 40, seed: 1 });
    expect(net.valLoss).toBeLessThan(lin * 0.3);
  });
});
