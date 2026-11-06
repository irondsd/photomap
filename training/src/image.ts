import sharp, { type Sharp } from "sharp";
import { mkdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Pixels } from "./fit";

/**
 * Decoding for training: photos oriented upright and scaled to a working size, cached as PNG
 * so HEIC originals (decoded by macOS's `sips`) are only decoded once.
 */

sharp.cache(false);
const OPEN = { failOn: "none", limitInputPixels: 0, animated: false } as const;

export async function toPixels(img: Sharp): Promise<Pixels> {
  const { data, info } = await img.toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length),
    width: info.width,
    height: info.height,
  };
}

export const fromPixels = (p: Pixels) =>
  sharp(Buffer.from(p.data.buffer, p.data.byteOffset, p.data.length), {
    raw: { width: p.width, height: p.height, channels: 4 },
  });

async function sips(path: string): Promise<Buffer | null> {
  if (process.platform !== "darwin") return null;
  const out = join(tmpdir(), `photomap-train-${process.pid}-${Math.random().toString(36).slice(2)}.jpg`);
  try {
    const proc = Bun.spawn(["sips", "-s", "format", "jpeg", "-Z", "2048", path, "--out", out], {
      stdout: "ignore",
      stderr: "ignore",
    });
    if ((await proc.exited) !== 0) return null;
    return Buffer.from(await Bun.file(out).arrayBuffer());
  } finally {
    await rm(out, { force: true });
  }
}

/** Upright, fitting inside `size`×`size`; null when it can't be decoded. */
async function decode(path: string, size: number): Promise<Pixels | null> {
  const fit = (input: string | Buffer) =>
    toPixels(sharp(input, OPEN).rotate().resize(size, size, { fit: "inside", withoutEnlargement: true }));
  try {
    return await fit(path);
  } catch {
    const buf = await sips(path).catch(() => null);
    return buf ? fit(buf).catch(() => null) : null;
  }
}

export class ImageCache {
  constructor(
    private dir: string,
    readonly size: number,
  ) {}

  private async file(path: string): Promise<string> {
    const s = await stat(path);
    const key = Bun.hash(`${path}\0${s.mtimeMs}\0${s.size}\0${this.size}`).toString(16).padStart(16, "0");
    return join(this.dir, key.slice(0, 2), `${key}.png`);
  }

  /** The photo at working size. */
  async load(path: string): Promise<Pixels | null> {
    const file = await this.file(path).catch(() => null);
    if (!file) return null;
    if (existsSync(file)) return toPixels(sharp(file));
    const px = await decode(path, this.size);
    if (!px) return null;
    await mkdir(join(file, ".."), { recursive: true });
    await fromPixels(px).png({ compressionLevel: 3 }).toFile(file);
    return px;
  }
}

/** Scales to exactly `w`×`h`. */
export const resizeTo = (p: Pixels, w: number, h: number) =>
  p.width === w && p.height === h ? Promise.resolve(p) : toPixels(fromPixels(p).resize(w, h, { fit: "fill" }));

/**
 * How alike two images' structure is, from -1 to 1: the correlation of their edge strength at
 * a small size. Tone and colour edits barely change it; a crop, turn or different photo does.
 */
export function structure(a: Pixels, b: Pixels, size = 64): number {
  const ea = edges(a, size);
  const eb = edges(b, size);
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < ea.length; i++) {
    ma += ea[i]!;
    mb += eb[i]!;
  }
  ma /= ea.length;
  mb /= eb.length;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < ea.length; i++) {
    const x = ea[i]! - ma;
    const y = eb[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/** Sobel magnitude of luma, area-averaged to `size` on the long side, each image normalised. */
function edges(p: Pixels, size: number): Float32Array {
  const s = Math.min(1, size / Math.max(p.width, p.height));
  const w = Math.max(3, Math.round(p.width * s));
  const h = Math.max(3, Math.round(p.height * s));
  const g = new Float32Array(w * h);
  const cnt = new Float32Array(w * h);
  for (let y = 0; y < p.height; y++) {
    const row = Math.min(h - 1, Math.floor((y * h) / p.height)) * w;
    for (let x = 0; x < p.width; x++) {
      const k = row + Math.min(w - 1, Math.floor((x * w) / p.width));
      const i = (y * p.width + x) * 4;
      g[k]! += 0.2126 * p.data[i]! + 0.7152 * p.data[i + 1]! + 0.0722 * p.data[i + 2]!;
      cnt[k]! += 1;
    }
  }
  let mean = 0;
  for (let i = 0; i < g.length; i++) mean += g[i] = cnt[i] ? g[i]! / cnt[i]! : 0;
  mean /= g.length;
  // Divide out overall brightness so a darker copy has the same edges.
  for (let i = 0; i < g.length; i++) g[i] = g[i]! / (mean + 1);
  const out = new Float32Array(w * h);
  const at = (x: number, y: number) => g[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))]!;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx =
        at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
      const gy =
        at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
      out[y * w + x] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return out;
}
