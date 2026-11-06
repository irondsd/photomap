import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { TWEAKS, type Tweaks } from "../../src/edits/model";
import { toneMaps } from "../../src/edits/tweaks";
import { meanDeltaE, toLab } from "./color";
import { isVal, samplePixels, type Sample } from "./dataset";
import { render, type Pixels } from "./fit";
import { fromPixels, type ImageCache } from "./image";
import { predictTweaks, type AutoModel } from "../../src/edits/auto/model";
import { usable } from "./train";

/**
 * A contact sheet of validation samples for judging by eye: before | Google's edit |
 * our sliders fitted to it | the model's guess, with the numbers under each row.
 */
export async function review(o: {
  samples: Sample[];
  model: AutoModel | null;
  cache: ImageCache;
  outDir: string;
  n: number;
  maxFit: number;
}): Promise<string> {
  await mkdir(o.outDir, { recursive: true });
  const val = o.samples.filter((s) => isVal(s.group) && usable(s, o.maxFit));
  // Real pairs first, then synthetic; worst model results are the interesting ones, but a spread is fairer.
  const rows = [...val.filter((s) => s.kind === "pair"), ...val.filter((s) => s.kind === "synthetic")].slice(0, o.n);
  const html: string[] = [];
  for (const s of rows) {
    const px = await samplePixels(s, o.cache);
    if (!px) continue;
    const n = px.target.width * px.target.height;
    const lab = toLab(px.target.data, n);
    const maps = toneMaps(px.input.data, px.input.width, px.input.height);
    const pred = o.model ? predictTweaks(o.model, s.features) : null;
    const tiles: Pixels[] = [px.input, px.target, render(px.input, s.tweaks, maps)];
    let predDE: number | null = null;
    if (pred) {
      const out = render(px.input, pred, maps);
      predDE = meanDeltaE(lab, out.data, n);
      tiles.push(out);
    }
    const file = `${s.id.replace(/:/g, "_")}.jpg`;
    await strip(tiles).then((img) => img.toFile(join(o.outDir, file)));
    html.push(`<figure><img src="${file}" loading="lazy">
<figcaption><b>${s.kind}</b> ${esc(s.original ?? s.edited)}<br>
ΔE before ${s.baseDeltaE.toFixed(1)} · fitted ${s.deltaE.toFixed(1)}${predDE != null ? ` · model ${predDE.toFixed(1)}` : ""}<br>
fitted: ${fmt(s.tweaks)}${pred ? `<br>model: ${fmt(pred)}` : ""}</figcaption></figure>`);
  }
  const page = `<!doctype html><meta charset="utf-8"><title>Auto enhance review</title>
<style>body{font:13px system-ui;margin:16px;background:#111;color:#ddd}figure{margin:0 0 24px}img{max-width:100%;display:block}
figcaption{margin-top:4px;line-height:1.5;word-break:break-all}.h{color:#999;margin-bottom:12px}</style>
<div class="h">Each row: before · Google's edit · our sliders fitted to the edit · ${o.model ? `the model (${o.model.kind})` : "no model yet"}. ΔE is the mean colour difference to Google's edit.</div>
${html.join("\n")}`;
  const index = join(o.outDir, "index.html");
  await Bun.write(index, page);
  return index;
}

const fmt = (t: Tweaks) =>
  TWEAKS.filter((k) => t[k])
    .map((k) => `${k} ${t[k] > 0 ? "+" : ""}${t[k]}`)
    .join(", ") || "none";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

async function strip(tiles: Pixels[]) {
  const h = tiles[0]!.height;
  const gap = 6;
  const widths = tiles.map((t) => t.width);
  const total = widths.reduce((a, b) => a + b, 0) + gap * (tiles.length - 1);
  const parts = await Promise.all(tiles.map((t) => fromPixels(t).png().toBuffer()));
  let left = 0;
  const composite = parts.map((input, i) => {
    const c = { input, left, top: 0 };
    left += widths[i]! + gap;
    return c;
  });
  const sharp = (await import("sharp")).default;
  return sharp({ create: { width: total, height: h, channels: 3, background: "#111" } })
    .composite(composite)
    .jpeg({ quality: 85 });
}
