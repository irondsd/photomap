import { chmod, rename, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { kindOf } from "../config";
import { db, getRoot, setEdits, upsertPhoto, type PhotoRow } from "../db";
import { extract } from "../scan/extract";
import { keepAssignedLocation } from "../scan/locate";
import { keepManualDate } from "../scan/manualDates";
import { applyDateInference } from "../scan/fixDates";
import { systemDecode } from "../thumbs";
import type { Edits } from "./model";
import { fromRaw, renderEdits, type RawImage } from "./render";

/** Formats sharp can write back without losing what the file is. HEIC and RAW edits go to a JPEG copy. */
const WRITABLE = new Set(["jpg", "jpeg", "png", "webp", "tif", "tiff"]);

export const canWriteInto = (p: Pick<PhotoRow, "kind" | "ext">) => p.kind === "photo" && WRITABLE.has(p.ext);

function encode(img: RawImage, ext: string) {
  const s = fromRaw(img);
  switch (ext) {
    case "png":
      return s.png();
    case "webp":
      return s.removeAlpha().webp({ quality: 92 });
    case "tif":
    case "tiff":
      return s.removeAlpha().tiff({ quality: 95 });
    default:
      return s.removeAlpha().jpeg({ quality: 92, chromaSubsampling: "4:4:4" });
  }
}

/**
 * Copies the original's metadata (dates, GPS, camera) onto a rendered file, minus what
 * no longer describes the pixels: orientation (already applied), size and embedded previews.
 * Best effort: without exiftool the file just has no metadata, and the index fills in from the original.
 */
async function copyMetadata(from: string, to: string) {
  if (!Bun.which("exiftool")) return;
  await Bun.$`exiftool -q -q -m -overwrite_original -TagsFromFile ${from} -all:all --Orientation --ExifImageWidth --ExifImageHeight --ImageWidth --ImageHeight --ThumbnailImage --PreviewImage ${to}`
    .quiet()
    .nothrow();
}

/** Full size, from the file when libvips can decode it, else through the system's decoder (HEIC, RAW). */
async function renderFull(p: PhotoRow, e: Edits): Promise<RawImage> {
  try {
    return await renderEdits(p.path, e, null);
  } catch {
    const decoded = await systemDecode(p, null, join(tmpdir(), `photomap-edit-${process.pid}-${p.id}`));
    if (!decoded) throw new Error("This file can't be decoded");
    return renderEdits(decoded, e, null);
  }
}

/**
 * Indexes one file right away, as a scan would, carrying over what was set by hand on `like`
 * (the same file before it was rewritten, or the original of a copy).
 */
async function indexFile(path: string, like: PhotoRow, size: [number, number]): Promise<number> {
  const root = getRoot(like.root_id);
  if (!root) throw new Error("The folder is no longer in the library");
  const st = await stat(path);
  const name = basename(path);
  const ext = extname(name).slice(1).toLowerCase();
  const kind = kindOf(ext) ?? "photo";
  let meta = await extract(path, kind, name, st.mtimeMs);
  if (like.gps_source === "manual" && like.lat != null && like.lon != null) {
    meta = keepAssignedLocation(meta, like.lat, like.lon);
  } else if (like.gps_source?.startsWith("inferred:") && meta.lat == null && like.lat != null && like.lon != null) {
    meta = keepAssignedLocation(meta, like.lat, like.lon, like.gps_source as `inferred:${string}`);
  }
  meta = keepManualDate(meta, like);
  upsertPhoto({
    root_id: root.id,
    path,
    rel_dir: relative(root.path, dirname(path)),
    name,
    ext,
    kind,
    size: st.size,
    mtime: Math.round(st.mtimeMs),
    scan_gen: like.scan_gen,
    ...meta,
    // The pixels as rendered, whatever the copied tags say.
    width: size[0],
    height: size[1],
    orientation: 1,
  });
  return db.query<{ id: number }, [string]>(`SELECT id FROM photos WHERE path = ?`).get(path)!.id;
}

/** Writes to a hidden file next to `dest`, then moves it into place, so a failure leaves `dest` as it was. */
async function writeNextTo(dest: string, img: RawImage, ext: string, metaFrom: string, mode?: number) {
  const tmp = join(dirname(dest), `.${basename(dest)}.photomap-${Math.random().toString(36).slice(2)}.${ext}`);
  try {
    await encode(img, ext).toFile(tmp);
    await copyMetadata(metaFrom, tmp);
    if (mode != null) await chmod(tmp, mode);
    await rename(tmp, dest);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

function copyPath(p: PhotoRow, ext: string): string {
  const dir = dirname(p.path);
  const stem = basename(p.name, extname(p.name));
  for (let n = 1; ; n++) {
    const path = join(dir, `${stem}-edited${n > 1 ? `(${n})` : ""}.${ext}`);
    if (!existsSync(path)) return path;
  }
}

/**
 * Saves the photo with `edits` as a new file next to it ("IMG_1234-edited.jpg"), in the same
 * format when it can be written, as JPEG otherwise. The original and its saved edits stay as they are.
 */
export async function saveCopy(p: PhotoRow, e: Edits): Promise<{ id: number; name: string }> {
  const img = await renderFull(p, e);
  const ext = canWriteInto(p) ? p.ext : "jpg";
  const path = copyPath(p, ext);
  await writeNextTo(path, img, ext, p.path);
  const id = await indexFile(path, p, [img.width, img.height]);
  // A copy without a date of its own gets the original's ("-edited" is a known copy name).
  await applyDateInference();
  return { id, name: basename(path) };
}

/** Writes the saved edits into the file itself and forgets them. There is no undo. */
export async function writeIntoFile(p: PhotoRow, e: Edits): Promise<void> {
  if (!canWriteInto(p)) throw new Error(`.${p.ext} files can't be rewritten; save a copy instead`);
  const img = await renderFull(p, e);
  const { mode } = await stat(p.path);
  await writeNextTo(p.path, img, p.ext, p.path, mode);
  setEdits(p.id, null);
  await indexFile(p.path, { ...p, edits: null }, [img.width, img.height]);
}
