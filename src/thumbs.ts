import sharp from "sharp";
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { THUMB_DIR, CPUS } from "./config";
import { db, type PhotoRow } from "./db";

export type ThumbSize = "s" | "m" | "l";
export const THUMB_SIZES: readonly ThumbSize[] = ["s", "m", "l"];

const SPEC: Record<ThumbSize, { px: number; quality: number }> = {
  s: { px: 320, quality: 74 }, // square crop: sidebar grid and map markers
  m: { px: 400, quality: 76 }, // 400 px tall, uncropped: gallery rows (2× for ~200 px rows)
  l: { px: 2048, quality: 84 }, // fit inside: viewer
};

sharp.cache(false);

type ThumbSource = Pick<PhotoRow, "id" | "path" | "mtime" | "kind" | "duration">;

const cacheKey = (p: ThumbSource) => Bun.hash(`${p.path}\0${p.mtime}`).toString(16).padStart(16, "0");

function cacheFile(p: ThumbSource, size: ThumbSize): string {
  const key = cacheKey(p);
  return join(THUMB_DIR, size, key.slice(0, 2), `${key}.jpg`);
}

/**
 * Identifies the file a thumbnail was made from. Photo ids can be reused (a rebuilt
 * index, a removed and re-added folder), so browsers must revalidate against this
 * rather than cache by URL.
 */
export const thumbETag = (p: ThumbSource, size: ThumbSize) => `"${size}${cacheKey(p)}"`;

export const hasThumb = (p: ThumbSource, size: ThumbSize) => existsSync(cacheFile(p, size));

class Limiter {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

const limiter = new Limiter(Math.max(2, CPUS));
const inflight = new Map<string, Promise<string | null>>();

async function run(cmd: string[]): Promise<Buffer | null> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
  const buf = Buffer.from(await new Response(proc.stdout).arrayBuffer());
  return (await proc.exited) === 0 && buf.length ? buf : null;
}

async function videoFrame(p: ThumbSource, px: number): Promise<Buffer | null> {
  const at = p.duration && p.duration > 2 ? Math.min(1, p.duration / 3) : 0;
  return run([
    "ffmpeg", "-v", "error", "-ss", String(at), "-i", p.path,
    "-frames:v", "1", "-vf", `scale='min(${px},iw)':-2`, "-f", "image2pipe", "-vcodec", "mjpeg", "-",
  ]);
}

/** macOS ImageIO decodes HEIC and most RAW formats that libvips can't. It keeps the orientation tag. */
async function sipsDecode(path: string, px: number, out: string): Promise<Buffer | null> {
  const tmp = `${out}.${process.pid}.${Math.random().toString(36).slice(2)}.sips.jpg`;
  try {
    const proc = Bun.spawn(["sips", "-s", "format", "jpeg", "-Z", String(px), path, "--out", tmp], { stdout: "ignore", stderr: "ignore" });
    if ((await proc.exited) !== 0) return null;
    return Buffer.from(await Bun.file(tmp).arrayBuffer());
  } catch {
    return null;
  } finally {
    await rm(tmp, { force: true });
  }
}

async function render(input: string | Buffer, size: ThumbSize): Promise<Buffer> {
  const { px, quality } = SPEC[size];
  let img = sharp(input, { failOn: "none", limitInputPixels: 0, animated: false }).rotate();
  img =
    size === "s" ? img.resize(px, px, { fit: "cover", position: "attention" })
    : size === "m" ? img.resize(px * 3, px, { fit: "inside", withoutEnlargement: true }) // panoramas up to 3:1
    : img.resize(px, px, { fit: "inside", withoutEnlargement: true });
  return img.jpeg({ quality, mozjpeg: false }).toBuffer();
}

async function generate(p: ThumbSource, size: ThumbSize, out: string): Promise<string | null> {
  const { px } = SPEC[size];
  let data: Buffer | null = null;
  if (p.kind === "video") {
    const frame = await videoFrame(p, px);
    if (frame) data = await render(frame, size);
  } else {
    if (p.kind === "photo") data = await render(p.path, size).catch(() => null);
    if (!data && process.platform === "darwin") {
      const decoded = await sipsDecode(p.path, size === "l" ? px : 1200, out);
      if (decoded) data = await render(decoded, size).catch(() => null);
    }
  }
  if (!data) return null;
  await mkdir(join(out, ".."), { recursive: true });
  await Bun.write(out, data);
  return out;
}

/** Returns a cached thumbnail path, generating it if needed. null when the file can't be decoded. */
export function getThumb(p: ThumbSource, size: ThumbSize): Promise<string | null> {
  const out = cacheFile(p, size);
  if (existsSync(out)) return Promise.resolve(out);
  let job = inflight.get(out);
  if (!job) {
    job = limiter
      .run(() => (existsSync(out) ? Promise.resolve(out) : generate(p, size, out)))
      .catch(() => null)
      .finally(() => inflight.delete(out));
    inflight.set(out, job);
  }
  return job;
}

// On globalThis so `bun --hot` reloads don't start a second pass alongside the first.
const g = globalThis as { __pmPregenRunning?: boolean };

/**
 * Fills the sidebar (s) and gallery (m) thumbnail caches for the whole library, newest
 * photos first. The server passes fewer workers so on-demand requests from the UI still get slots.
 */
export async function pregenerateThumbs(onProgress?: (done: number, total: number) => void, workers = Math.max(2, CPUS)) {
  if (g.__pmPregenRunning) return;
  g.__pmPregenRunning = true;
  try {
    const jobs: [ThumbSource, ThumbSize][] = [];
    for (const r of db
      .query<ThumbSource, []>(`SELECT id, path, mtime, kind, duration FROM photos WHERE missing = 0 ORDER BY taken_local DESC`)
      .all()) {
      for (const size of ["s", "m"] as const) if (!existsSync(cacheFile(r, size))) jobs.push([r, size]);
    }
    let done = 0;
    let i = 0;
    await Promise.all(
      Array.from({ length: workers }, async () => {
        while (i < jobs.length) {
          const [r, size] = jobs[i++]!;
          await getThumb(r, size);
          onProgress?.(++done, jobs.length);
        }
      }),
    );
  } finally {
    g.__pmPregenRunning = false;
  }
}
