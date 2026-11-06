import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { TWEAKS } from "../src/edits/model";
import { readJsonl, type Reject, type Sample } from "./src/dataset";
import { ImageCache } from "./src/image";
import type { AutoModel } from "../src/edits/auto/model";
import { EDITED_SUFFIXES, findPairs, listFiles, type Pair } from "./src/pairs";
import { defaultWorkers, prepare } from "./src/prepare";
import { review } from "./src/review";
import { extractTakeout } from "./src/takeout";
import { train } from "./src/train";

const USAGE = `Auto-enhance training. Data lives in training/data (or --data=<dir>).

  bun cli.ts takeout <zip…> [--out=DIR] [--dry-run]       extract only edits and their originals (default out: data/photos)
  bun cli.ts pairs <folder…> [--suffix=edited,editado]   find X / X-edited pairs → pairs.json
  bun cli.ts prepare [--synthetic=3] [--no-pairs] [--limit=N] [--workers=N] [--size=256] [--lambda=0.5] [--min-structure=0.7]
                                                          fit our sliders to each pair, make synthetic samples → samples.jsonl
  bun cli.ts stats                                        what's in the dataset
  bun cli.ts train [--hidden=128,64] [--epochs=600] [--max-fit=4] [--synthetic] [--pair-weight=3] [--eval=300]
                                                          train and compare models → model.json, metrics.json
  bun cli.ts export [--out=FILE]                         copy the trained model into the app (src/edits/auto/model.json)
  bun cli.ts review [--n=60]                              contact sheet of validation samples → review/index.html
`;

const [cmd, ...rest] = process.argv.slice(2);
const flags = new Map<string, string>();
const args: string[] = [];
for (const a of rest) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) flags.set(m[1]!, m[2] ?? "true");
  else args.push(a);
}
const num = (k: string, d: number) => (flags.has(k) ? Number(flags.get(k)) : d);
const on = (k: string) => flags.get(k) === "true";

const dataDir = resolve(flags.get("data") ?? join(import.meta.dir, "data"));
const files = {
  pairs: join(dataDir, "pairs.json"),
  samples: join(dataDir, "samples.jsonl"),
  rejects: join(dataDir, "rejects.jsonl"),
  model: join(dataDir, "model.json"),
  metrics: join(dataDir, "metrics.json"),
  review: join(dataDir, "review"),
};
const size = num("size", 256);
const cache = new ImageCache(join(dataDir, `cache-${size}`), size);
const log = (s: string) => console.log(s);

async function main() {
  await mkdir(dataDir, { recursive: true });
  switch (cmd) {
    case "takeout": {
      if (!args.length) throw new Error("takeout: give the zip files");
      const out = resolve(flags.get("out") ?? join(dataDir, "photos"));
      const r = await extractTakeout(
        args.map((a) => resolve(a)),
        out,
        log,
        on("dry-run"),
      );
      if (!on("dry-run")) log(`extracted ${r.extracted} files → ${out}\nnext: bun cli.ts pairs ${out}`);
      return;
    }
    case "pairs": {
      if (!args.length) throw new Error("pairs: give one or more folders");
      const suffixes = flags.get("suffix")?.split(",") ?? EDITED_SUFFIXES;
      const list = await listFiles(args.map((a) => resolve(a)));
      const { pairs, stats } = findPairs(list, suffixes);
      await Bun.write(files.pairs, JSON.stringify(pairs, null, 1));
      log(
        `${stats.images} images: ${stats.edited} edits, ${stats.withOriginal} with their original, ${stats.duplicates} album copies dropped → ${files.pairs}`,
      );
      return;
    }
    case "prepare": {
      if (!existsSync(files.pairs)) throw new Error("prepare: run `pairs` first");
      const pairs = (await Bun.file(files.pairs).json()) as Pair[];
      const workers = num("workers", defaultWorkers());
      log(`${pairs.length} edits, ${workers} workers, working size ${size}px`);
      const r = await prepare({
        pairs,
        cache,
        samplesFile: files.samples,
        rejectsFile: files.rejects,
        synthetic: num("synthetic", 3),
        usePairs: !on("no-pairs"),
        lambda: num("lambda", 0.5),
        minStructure: num("min-structure", 0.7),
        workers,
        limit: flags.has("limit") ? num("limit", 0) : undefined,
        log,
      });
      log(`added ${r.added} samples, rejected ${r.rejected}`);
      return;
    }
    case "stats": {
      const samples = await readJsonl<Sample>(files.samples);
      const rejects = await readJsonl<Reject>(files.rejects);
      for (const kind of ["pair", "synthetic"] as const) {
        const s = samples.filter((x) => x.kind === kind);
        if (!s.length) continue;
        const mean = (f: (x: Sample) => number) => (s.reduce((a, x) => a + f(x), 0) / s.length).toFixed(2);
        log(`${kind}: ${s.length} samples, ΔE before ${mean((x) => x.baseDeltaE)} → fitted ${mean((x) => x.deltaE)}`);
        log(`  mean |slider|: ${TWEAKS.map((k) => `${k} ${mean((x) => Math.abs(x.tweaks[k]))}`).join(", ")}`);
        if (kind === "pair") {
          const buckets = [1, 2, 3, 4, 6, 10, Infinity];
          log(
            `  fitted ΔE: ${buckets.map((b, i) => `≤${b}: ${s.filter((x) => x.deltaE <= b && (i === 0 || x.deltaE > buckets[i - 1]!)).length}`).join(", ")}`,
          );
        }
      }
      const reasons = new Map<string, number>();
      for (const r of rejects) {
        const k = r.reason.split(" ")[0] === "structure" ? "structure" : r.reason;
        reasons.set(k, (reasons.get(k) ?? 0) + 1);
      }
      if (rejects.length) log(`rejected: ${[...reasons].map(([k, v]) => `${k} ${v}`).join(", ")}`);
      return;
    }
    case "train": {
      const samples = await readJsonl<Sample>(files.samples);
      const { model, metrics } = await train({
        samples,
        cache,
        maxFit: num("max-fit", 4),
        pairWeight: num("pair-weight", 3),
        useSynthetic: on("synthetic"),
        hidden: (flags.get("hidden") ?? "128,64").split(",").map(Number),
        epochs: num("epochs", 600),
        evalLimit: num("eval", 300),
        log,
      });
      await Bun.write(files.model, JSON.stringify(model));
      await Bun.write(files.metrics, JSON.stringify(metrics, null, 2));
      log(`\nmean ΔE to the target on validation (lower is better):`);
      for (const [kind, s] of Object.entries(metrics.image)) {
        if (!s) continue;
        const models = Object.entries(s.models)
          .map(([k, v]) => `${k} ${v}`)
          .join(", ");
        const gap = s.none - s.fitted;
        const closed =
          gap > 0
            ? ` — ${metrics.chosen} closes ${Math.round(((s.none - s.models[metrics.chosen]!) / gap) * 100)}% of the gap`
            : "";
        log(`  ${kind} (${s.n}): do nothing ${s.none}, best our sliders can do ${s.fitted}, ${models}${closed}`);
      }
      log(
        `slider error (points, mean abs) of ${metrics.chosen}: ${Object.entries(metrics.sliderMae[metrics.chosen]!)
          .map(([k, v]) => `${k} ${v}`)
          .join(", ")}`,
      );
      log(`saved ${metrics.chosen} → ${files.model}`);
      return;
    }
    case "export": {
      if (!existsSync(files.model)) throw new Error("export: run `train` first");
      const m = (await Bun.file(files.model).json()) as AutoModel;
      const out = resolve(flags.get("out") ?? join(import.meta.dir, "..", "src", "edits", "auto", "model.json"));
      const p = (v: number) => Number(v.toPrecision(5));
      const metrics = m.metrics as { image?: unknown; counts?: unknown } | undefined;
      const slim: AutoModel = {
        ...m,
        mean: m.mean.map(p),
        std: m.std.map(p),
        layers: m.layers.map((L) => ({ ...L, w: L.w.map(p), b: L.b.map(p) })),
        // Just enough to know where it came from.
        metrics: metrics && { counts: metrics.counts, image: metrics.image },
      };
      await Bun.write(out, JSON.stringify(slim));
      log(`${m.kind}, trained ${m.trainedAt} → ${out} (${(Bun.file(out).size / 1024).toFixed(0)} KB)`);
      return;
    }
    case "review": {
      const samples = await readJsonl<Sample>(files.samples);
      const model = existsSync(files.model) ? ((await Bun.file(files.model).json()) as AutoModel) : null;
      const index = await review({
        samples,
        model,
        cache,
        outDir: files.review,
        n: num("n", 60),
        maxFit: num("max-fit", 4),
      });
      log(`open ${index}`);
      return;
    }
    default:
      console.log(USAGE);
      if (cmd && cmd !== "help") process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
