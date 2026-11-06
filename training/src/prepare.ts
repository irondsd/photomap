import { availableParallelism } from "node:os";
import { sampleDistortion } from "./distort";
import { appendJsonl, hashId, readJsonl, type Reject, type Sample } from "./dataset";
import { FEATURE_VERSION } from "../../src/edits/auto/features";
import type { FitDone, FitTask } from "./fit.worker";
import { ImageCache, resizeTo, structure } from "./image";
import type { Pair } from "./pairs";

export interface PrepareOptions {
  pairs: Pair[];
  cache: ImageCache;
  samplesFile: string;
  rejectsFile: string;
  /** Synthetic samples made from each edit. */
  synthetic: number;
  /** Fit pairs (original → edit). Off to make synthetic samples only. */
  usePairs: boolean;
  lambda: number;
  /** Pairs less alike than this are crops, turns or different photos. */
  minStructure: number;
  workers: number;
  limit?: number;
  log?: (line: string) => void;
}

class Pool {
  private idle: Worker[] = [];
  private waiting: ((w: Worker) => void)[] = [];
  private all: Worker[] = [];

  constructor(n: number) {
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL("./fit.worker.ts", import.meta.url).href);
      this.all.push(w);
      this.idle.push(w);
    }
  }

  private take(): Promise<Worker> {
    const w = this.idle.pop();
    return w ? Promise.resolve(w) : new Promise((r) => this.waiting.push(r));
  }

  private give(w: Worker) {
    const next = this.waiting.shift();
    if (next) next(w);
    else this.idle.push(w);
  }

  async run(task: FitTask): Promise<FitDone> {
    const w = await this.take();
    try {
      return await new Promise<FitDone>((resolve, reject) => {
        w.onmessage = (e: MessageEvent<FitDone>) => resolve(e.data);
        w.onerror = (e) => reject(new Error(e.message));
        const transfer = [task.target.buffer, ...(task.input ? [task.input.buffer] : [])] as ArrayBuffer[];
        w.postMessage(task, transfer);
      });
    } finally {
      this.give(w);
    }
  }

  close() {
    for (const w of this.all) w.terminate();
  }
}

export const defaultWorkers = () => Math.max(1, availableParallelism() - 1);

const chromaMean = (d: Uint8ClampedArray) => {
  let s = 0;
  for (let p = 0; p < d.length; p += 4)
    s += Math.max(d[p]!, d[p + 1]!, d[p + 2]!) - Math.min(d[p]!, d[p + 1]!, d[p + 2]!);
  return s / (d.length / 4) / 255;
};

/**
 * Builds samples for every pair not already in the samples file, so an interrupted run picks
 * up where it stopped. A pair becomes one fitted pair sample (if it has a usable original) and
 * `synthetic` distorted copies of the edit.
 */
export async function prepare(o: PrepareOptions): Promise<{ added: number; rejected: number }> {
  const log = o.log ?? (() => {});
  const done = new Set<string>();
  for (const s of await readJsonl<Sample>(o.samplesFile)) done.add(s.id);
  for (const r of await readJsonl<Reject>(o.rejectsFile)) done.add(r.id);

  const pool = new Pool(o.workers);
  let added = 0;
  let rejected = 0;
  let processed = 0;
  const started = Date.now();
  const list = o.limit ? o.pairs.slice(0, o.limit) : o.pairs;

  const one = async (p: Pair) => {
    const group = hashId(p.edited);
    const pairId = `p:${group}`;
    const synIds = Array.from({ length: o.synthetic }, (_, k) => `s:${group}:${k}`);
    const wantPair = o.usePairs && p.original && !done.has(pairId);
    const wantSyn = synIds.filter((id) => !done.has(id));
    if (!wantPair && !wantSyn.length) return;

    const rejects: Reject[] = [];
    const samples: Sample[] = [];
    const target = await o.cache.load(p.edited);
    if (!target) {
      // Nothing can be made from it: mark every id so it isn't retried.
      for (const id of [...(wantPair ? [pairId] : []), ...wantSyn])
        rejects.push({ id, edited: p.edited, reason: "decode edited" });
      await appendJsonl(o.rejectsFile, rejects);
      rejected += rejects.length;
      return;
    }
    const base = {
      group,
      edited: p.edited,
      width: target.width,
      height: target.height,
      featureVersion: FEATURE_VERSION,
    };
    const jobs: Promise<void>[] = [];

    if (wantPair) {
      const reject = (reason: string, extra: Partial<Reject> = {}) =>
        rejects.push({ id: pairId, edited: p.edited, original: p.original!, reason, ...extra });
      const orig = await o.cache.load(p.original!);
      if (!orig) reject("decode original");
      else if (Math.abs(Math.log(orig.width / orig.height / (target.width / target.height))) > 0.01) reject("geometry");
      else {
        const input = await resizeTo(orig, target.width, target.height);
        const s = structure(input, target);
        if (s < o.minStructure) reject(`structure ${s.toFixed(2)}`);
        // A black-and-white or washed-out filter rather than an enhancement.
        else if (chromaMean(target.data) < 0.3 * chromaMean(input.data)) reject("desaturated filter");
        else
          jobs.push(
            pool
              .run({
                id: pairId,
                width: target.width,
                height: target.height,
                target: new Uint8ClampedArray(target.data),
                input: new Uint8ClampedArray(input.data),
                lambda: o.lambda,
              })
              .then((r) => {
                samples.push({ ...base, ...result(r), id: pairId, kind: "pair", original: p.original!, structure: s });
              }),
          );
      }
    }

    for (const id of wantSyn) {
      const k = Number(id.split(":")[2]);
      const distortion = sampleDistortion(Number(BigInt(`0x${group}`) % 2147483647n) + k * 7919);
      jobs.push(
        pool
          .run({
            id,
            width: target.width,
            height: target.height,
            target: new Uint8ClampedArray(target.data),
            distortion,
            lambda: o.lambda,
          })
          .then((r) => {
            samples.push({ ...base, ...result(r), id, kind: "synthetic", distortion });
          }),
      );
    }
    await Promise.all(jobs);
    await appendJsonl(o.samplesFile, samples);
    await appendJsonl(o.rejectsFile, rejects);
    added += samples.length;
    rejected += rejects.length;
  };

  try {
    // A few photos decode while the pool fits the ones before them.
    let next = 0;
    const lanes = Array.from({ length: Math.max(2, Math.ceil(o.workers / 2)) }, async () => {
      while (next < list.length) {
        const p = list[next++]!;
        try {
          await one(p);
        } catch (e) {
          log(`  ${p.edited}: ${(e as Error).message}`);
        }
        processed++;
        if (processed % 25 === 0 || processed === list.length) {
          const s = (Date.now() - started) / 1000;
          log(`  ${processed}/${list.length} photos, ${added} samples, ${rejected} rejected, ${s.toFixed(0)}s`);
        }
      }
    });
    await Promise.all(lanes);
  } finally {
    pool.close();
  }
  return { added, rejected };
}

const result = (r: FitDone) => ({
  tweaks: r.tweaks,
  deltaE: round(r.deltaE),
  baseDeltaE: round(r.baseDeltaE),
  features: r.features.map((v) => Number(v.toPrecision(5))),
});

const round = (v: number) => Math.round(v * 1000) / 1000;
