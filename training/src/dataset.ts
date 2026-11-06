import { existsSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import type { Tweaks } from "../../src/edits/model";
import { distort, type Distortion } from "./distort";
import type { Pixels } from "./fit";
import { resizeTo, type ImageCache } from "./image";

/**
 * One training example: a "before" image, the "after" it should become, our slider values
 * fitted between them, and the features of the "before". Images aren't stored; they're
 * reloaded from the cache (and synthetic ones rebuilt from their seed) when needed.
 */
export interface Sample {
  id: string;
  /** Samples of one photo share a group and always land in the same split. */
  group: string;
  kind: "pair" | "synthetic";
  /** The Google Photos edit: the target, and for synthetic samples also the source. */
  edited: string;
  /** For pairs: the unedited original, the input. */
  original?: string;
  distortion?: Distortion;
  width: number;
  height: number;
  tweaks: Tweaks;
  deltaE: number;
  baseDeltaE: number;
  /** For pairs: structural likeness of the two images, see `structure`. */
  structure?: number;
  featureVersion: number;
  features: number[];
}

export interface Reject {
  id: string;
  edited: string;
  original?: string;
  reason: string;
}

export const hashId = (s: string) => Bun.hash(s).toString(16).padStart(16, "0");

/** About one photo in `1/valEvery` goes to validation, the same every run. */
export const isVal = (group: string, valEvery = 5) =>
  Number(BigInt(`0x${hashId(`split\0${group}`)}`) % BigInt(valEvery)) === 0;

export async function readJsonl<T>(path: string): Promise<T[]> {
  if (!existsSync(path)) return [];
  const text = await Bun.file(path).text();
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // A line cut short by an interrupted run.
    }
  }
  return out;
}

export const appendJsonl = (path: string, rows: unknown[]) =>
  rows.length ? appendFile(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n") : Promise.resolve();

/** The before and after images of a sample, at its working size. */
export async function samplePixels(s: Sample, cache: ImageCache): Promise<{ input: Pixels; target: Pixels } | null> {
  const target = await cache.load(s.edited);
  if (!target) return null;
  const t = await resizeTo(target, s.width, s.height);
  if (s.kind === "synthetic") return { input: distort(t, s.distortion!), target: t };
  const orig = s.original ? await cache.load(s.original) : null;
  return orig ? { input: await resizeTo(orig, s.width, s.height), target: t } : null;
}
