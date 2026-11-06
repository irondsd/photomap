/// <reference lib="webworker" />
import { distort, type Distortion } from "./distort";
import { computeFeatures } from "../../src/edits/auto/features";
import { fitTweaks } from "./fit";

/** Fitting is pure JavaScript and CPU-bound, so it runs on a pool of these. */

export interface FitTask {
  id: string;
  width: number;
  height: number;
  target: Uint8ClampedArray;
  /** The before image for pairs; synthetic samples build it from the target. */
  input?: Uint8ClampedArray;
  distortion?: Distortion;
  lambda: number;
}

export interface FitDone {
  id: string;
  tweaks: import("../../src/edits/model").Tweaks;
  deltaE: number;
  baseDeltaE: number;
  evals: number;
  features: number[];
}

declare const self: Worker;

self.onmessage = (ev: MessageEvent<FitTask>) => {
  const t = ev.data;
  const target = { data: t.target, width: t.width, height: t.height };
  const input = t.input ? { data: t.input, width: t.width, height: t.height } : distort(target, t.distortion!);
  const r = fitTweaks(input, target, { lambda: t.lambda });
  const done: FitDone = {
    id: t.id,
    tweaks: r.tweaks,
    deltaE: r.deltaE,
    baseDeltaE: r.baseDeltaE,
    evals: r.evals,
    features: computeFeatures(input.data, input.width, input.height),
  };
  self.postMessage(done);
};
