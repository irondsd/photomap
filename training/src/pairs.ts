import { basename, dirname, extname, join } from "node:path";
import { stat } from "node:fs/promises";

/**
 * Finds Google Photos edits and their originals. Takeout exports an edit next to its
 * original as `IMG_1234-edited.jpg`, with the suffix in the account's language. Duplicates of a
 * name get a counter after the suffix (`IMG_1234-edited(1).jpg` for `IMG_1234(1).jpg`), long names
 * are cut short (`…-edi.jpg`), and the original may be a HEIC while the edit is a JPEG. The same
 * photo also appears in every album folder it belongs to; those copies are dropped.
 */

export const IMAGE_EXT = new Set([".jpg", ".jpeg", ".heic", ".heif", ".png", ".tif", ".tiff", ".webp", ".avif"]);

/** "edited" in the languages Takeout is most often exported in. */
export const EDITED_SUFFIXES = ["edited", "editado", "bearbeitet", "modifié", "modificato", "bewerkt"];

export interface FileEntry {
  path: string;
  size: number;
}

export interface Pair {
  /** The Google Photos edit: the "good" image. */
  edited: string;
  /** The unedited original, when it was exported too. */
  original: string | null;
}

export interface PairStats {
  images: number;
  edited: number;
  withOriginal: number;
  /** Album copies of an edit already found elsewhere. */
  duplicates: number;
}

const COUNTER = /\(\d+\)$/;

/** `{ base, counter }` when the name is an edit, e.g. `IMG_1-edited(2)` → `IMG_1`, `(2)`. */
export function parseEdited(
  stem: string,
  suffixes = EDITED_SUFFIXES,
): { base: string; counter: string; cut: boolean } | null {
  const counter = stem.match(COUNTER)?.[0] ?? "";
  const s = stem.slice(0, stem.length - counter.length);
  const lower = s.toLowerCase();
  for (const suf of suffixes) {
    if (lower.endsWith(`-${suf}`)) return { base: s.slice(0, s.length - suf.length - 1), counter, cut: false };
  }
  // Takeout cuts long names, sometimes inside the suffix. Only trusted when the original exists.
  for (const suf of suffixes) {
    for (let k = suf.length - 1; k >= 2; k--) {
      if (lower.endsWith(`-${suf.slice(0, k)}`)) return { base: s.slice(0, s.length - k - 1), counter, cut: true };
    }
  }
  return null;
}

/** Original formats to prefer when one photo was exported in several. */
const EXT_RANK = [".heic", ".heif", ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp", ".avif"];

export function findPairs(files: FileEntry[], suffixes = EDITED_SUFFIXES): { pairs: Pair[]; stats: PairStats } {
  const images = files.filter((f) => IMAGE_EXT.has(extname(f.path).toLowerCase()));
  // Non-edited images by directory + lower-case stem.
  const byStem = new Map<string, FileEntry[]>();
  const edits: { f: FileEntry; key: string; cut: boolean; stem: string }[] = [];
  for (const f of images) {
    const ext = extname(f.path);
    const stem = basename(f.path, ext);
    const e = parseEdited(stem, suffixes);
    const dir = dirname(f.path);
    // A truncated "-edi" could also be a real name; it counts as both until we know.
    if (e) edits.push({ f, key: join(dir, (e.base + e.counter).toLowerCase()), cut: e.cut, stem });
    if (!e || e.cut) {
      const key = join(dir, stem.toLowerCase());
      (byStem.get(key) ?? byStem.set(key, []).get(key)!).push(f);
    }
  }

  const seen = new Set<string>();
  const pairs: Pair[] = [];
  let duplicates = 0;
  for (const { f, key, cut } of edits) {
    const candidates = (byStem.get(key) ?? []).filter((c) => c.path !== f.path);
    if (cut && !candidates.length) continue;
    const original = candidates.sort((a, b) => rank(a.path, f.path) - rank(b.path, f.path))[0]?.path ?? null;
    // Album copies: same name and size.
    const id = `${basename(f.path).toLowerCase()}\0${f.size}`;
    if (seen.has(id)) {
      duplicates++;
      continue;
    }
    seen.add(id);
    pairs.push({ edited: f.path, original });
  }
  pairs.sort((a, b) => (a.edited < b.edited ? -1 : a.edited > b.edited ? 1 : 0));
  return {
    pairs,
    stats: {
      images: images.length,
      edited: pairs.length,
      withOriginal: pairs.filter((p) => p.original).length,
      duplicates,
    },
  };
}

function rank(path: string, edited: string): number {
  const ext = extname(path).toLowerCase();
  // The edit's own format first: Google keeps the format of JPEG originals.
  if (ext === extname(edited).toLowerCase()) return -1;
  const i = EXT_RANK.indexOf(ext);
  return i < 0 ? EXT_RANK.length : i;
}

/** Every file under the folders, with sizes. */
export async function listFiles(dirs: string[]): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  for (const dir of dirs) {
    const glob = new Bun.Glob("**/*");
    for await (const rel of glob.scan({ cwd: dir, onlyFiles: true, dot: false })) {
      if (!IMAGE_EXT.has(extname(rel).toLowerCase())) continue;
      const path = join(dir, rel);
      const s = await stat(path).catch(() => null);
      if (s) out.push({ path, size: s.size });
    }
  }
  return out;
}
