#!/usr/bin/env bun
/**
 * bun run scan [folder...] [--thumbs]
 *   With folders: registers them and scans them.
 *   Without: rescans every registered folder.
 *   --thumbs: also pre-generates small thumbnails afterwards.
 */
import { existsSync } from "node:fs";
import { getRoots, stats } from "../db";
import { expandHome, joinSplitPaths, registerTarget, type ScanTarget } from "./roots";
import { scanRoot, cancelScan, type ScanStatus } from "./scanner";
import { pregenerateThumbs } from "../thumbs";

const args = process.argv.slice(2);
const withThumbs = args.includes("--thumbs");

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

const folders = joinSplitPaths(
  args.filter((a) => !a.startsWith("--")),
  (p) => existsSync(expandHome(p)),
);

let targets: ScanTarget[];
try {
  targets = folders.length ? folders.map(registerTarget) : getRoots().map((root) => ({ root, subdir: null }));
} catch (err) {
  const msg = (err as Error).message;
  fail(
    msg.startsWith("Folder not found")
      ? `${msg}\n       (paths with spaces need quotes: bun run scan "~/Pictures/My Photos")`
      : msg,
  );
}
if (!targets.length) fail("No folders registered. Usage: bun run scan ~/Pictures [--thumbs]");

process.on("SIGINT", () => {
  console.log("\nCancelling…");
  cancelScan();
});

const isTTY = process.stdout.isTTY;
const line = (s: string) => (isTTY ? process.stdout.write(`\r\x1b[2K${s}`) : undefined);
const fmt = (s: ScanStatus) =>
  s.phase === "walking"
    ? `  walking… ${s.found.toLocaleString()} media files found`
    : `  ${s.processed.toLocaleString()}/${s.found.toLocaleString()}  +${s.added} ~${s.updated} =${s.unchanged} errors:${s.errors}`;

for (const { root, subdir } of targets) {
  console.log(subdir ? `Scanning ${subdir} (part of ${root.path})` : `Scanning ${root.path}`);
  const t0 = performance.now();
  const r = await scanRoot(root, (s) => line(fmt(s)), subdir);
  line("");
  const secs = (performance.now() - t0) / 1000;
  console.log(
    `${isTTY ? "\r" : ""}  ${r.phase}: ${r.found.toLocaleString()} files in ${secs.toFixed(1)}s — ` +
      `${r.added} added, ${r.updated} updated, ${r.unchanged} unchanged, ${r.removed} missing, ${r.errors} errors` +
      (r.message ? ` (${r.message})` : ""),
  );
  if (r.phase === "cancelled") process.exit(130);
}

const s = stats();
const pct = (n: number) => (s.total ? ` (${((n / s.total) * 100).toFixed(1)}%)` : "");
const date = (t: number | null) => (t == null ? "?" : new Date(t * 1000).toISOString().slice(0, 10));
console.log(`
Library
  total       ${s.total.toLocaleString()}
  geotagged   ${s.geotagged.toLocaleString()}${pct(s.geotagged)}
  date range  ${date(s.range.min)} → ${date(s.range.max)}
  kinds       ${s.kinds.map((k) => `${k.kind} ${k.n}`).join(", ")}
  time from   ${s.timeSources.map((t) => `${t.source ?? "none"} ${t.n}`).join(", ")}
  countries   ${
    s.countries
      .slice(0, 12)
      .map((c) => `${c.name} ${c.n}`)
      .join(", ") || "—"
  }
  cameras     ${
    s.cameras
      .slice(0, 8)
      .map((c) => `${c.model} ${c.n}`)
      .join(", ") || "—"
  }`);

if (withThumbs) {
  console.log("\nGenerating thumbnails…");
  const t0 = performance.now();
  await pregenerateThumbs((done, total) => line(`  ${done}/${total}`));
  line("");
  console.log(`${isTTY ? "\r" : ""}  done in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
}
