import { existsSync, mkdirSync } from "node:fs";
import { rename, rm, utimes } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { db } from "../db";
import { CHECK_BATCH, UPLOAD_HEADERS, type ManifestItem, type MediaKind } from "./protocol";

/** Half-written uploads. Dot folders are never scanned, so these never reach the index. */
const INCOMING = ".incoming";

export type Upload = { filename: string; takenAt: number; kind: MediaKind };

export type Layout = "month" | "flat";

const findStmt = db.query<{ path: string }, [string, number]>(
  `SELECT path FROM synced_files WHERE filename = ? AND taken_at = ?`,
);

/**
 * Wall-clock times are local and the phone's are UTC, so they can differ by up to 14 hours
 * (plus a little slack). Generic names like IMG_0001.jpg from different cameras almost never
 * collide that close together.
 */
export const SAME_FILE_WINDOW_S = 14 * 3600 + 120;

const inLibraryStmt = db.query<{ n: number }, [string, number, number]>(
  `SELECT COUNT(*) n FROM photos WHERE name = ? AND missing = 0
   AND (taken_local IS NULL OR ABS(taken_local - ?) <= ?)`,
);

/**
 * Whether the library already has this phone file, whether it came through sync or was copied
 * over some other way (a camera roll export, Google Photos): the same name, taken around then.
 */
function alreadyHave(filename: string, takenAt: number): boolean {
  if (findStmt.get(filename, takenAt)) return true;
  return inLibraryStmt.get(filename, takenAt / 1000, SAME_FILE_WINDOW_S)!.n > 0;
}
const recordStmt = db.query(
  `INSERT OR REPLACE INTO synced_files (filename, taken_at, kind, size, path, synced_at) VALUES (?, ?, ?, ?, ?, ?)`,
);

/** A file name safe to create inside the sync folder, or null. */
export function safeFilename(name: string): string | null {
  if (name.length === 0 || name.length > 255) return null;
  if (name !== basename(name) || name.includes("/") || name.includes("\\") || name.includes("\0")) return null;
  if (name.startsWith(".")) return null;
  return name;
}

function isTime(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0;
}

/** The check request's items, or an error message. */
export function parseManifest(body: unknown): ManifestItem[] | string {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return "items must be a list";
  if (items.length > CHECK_BATCH) return `at most ${CHECK_BATCH} items per check`;
  const out: ManifestItem[] = [];
  for (const raw of items) {
    const { id, filename, takenAt, kind } = (raw ?? {}) as Record<string, unknown>;
    if (typeof id !== "string" || typeof filename !== "string" || !isTime(takenAt)) {
      return "each item needs an id, a filename and a takenAt";
    }
    out.push({ id, filename, takenAt, kind: kind === "video" ? "video" : "photo" });
  }
  return out;
}

/** The ids of the items not received yet. */
export function missingItems(items: ManifestItem[]): string[] {
  return items.filter((i) => !alreadyHave(i.filename, i.takenAt)).map((i) => i.id);
}

/** An upload's description from its headers, or an error message. */
export function parseUpload(headers: Headers): Upload | string {
  let filename: string | null = null;
  try {
    filename = safeFilename(decodeURIComponent(headers.get(UPLOAD_HEADERS.filename) ?? ""));
  } catch {
    // Malformed percent-encoding: treated as no name.
  }
  if (!filename) return `${UPLOAD_HEADERS.filename} must be a plain file name`;
  const takenAt = Number(headers.get(UPLOAD_HEADERS.takenAt));
  if (!isTime(takenAt)) return `${UPLOAD_HEADERS.takenAt} must be a time in ms`;
  const kind = headers.get(UPLOAD_HEADERS.kind) === "video" ? "video" : "photo";
  return { filename, takenAt, kind };
}

/**
 * <dir>/<year>/<month>/<name> (in this machine's time zone), or <dir>/<name> when flat,
 * with " (2)" etc. when the name is taken.
 */
export function destination(dir: string, filename: string, takenAt: number, layout: Layout = "month"): string {
  const d = new Date(takenAt);
  const folder =
    layout === "flat" ? dir : join(dir, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"));
  const ext = extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  let path = join(folder, filename);
  for (let n = 2; existsSync(path); n++) path = join(folder, `${stem} (${n})${ext}`);
  return path;
}

export class UploadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Streams the body to a temporary file, then moves it into place, so a dropped connection never
 * leaves a partial photo in the library. Returns the path relative to `dir`.
 */
export async function receive(
  dir: string,
  upload: Upload,
  body: ReadableStream<Uint8Array> | null,
  expected: number | null,
  layout: Layout = "month",
) {
  const known = findStmt.get(upload.filename, upload.takenAt);
  if (known) return { path: relative(dir, known.path), created: false };
  if (!body) throw new UploadError(400, "the file is missing from the request body");

  const tmpDir = join(dir, INCOMING);
  mkdirSync(tmpDir, { recursive: true });
  const tmp = join(tmpDir, `${crypto.randomUUID()}${extname(upload.filename)}`);
  const writer = Bun.file(tmp).writer();
  let open = true;
  let size = 0;
  try {
    for await (const chunk of body) {
      writer.write(chunk);
      size += chunk.byteLength;
    }
    open = false;
    await writer.end();
    if (expected != null && size !== expected) {
      throw new UploadError(400, `received ${size} of ${expected} bytes`);
    }
    if (size === 0) throw new UploadError(400, "the file is empty");

    const path = destination(dir, upload.filename, upload.takenAt, layout);
    mkdirSync(join(path, ".."), { recursive: true });
    await rename(tmp, path);
    // Files with no date of their own (screenshots, some downloads) are dated by their mtime.
    const seconds = upload.takenAt / 1000;
    await utimes(path, seconds, seconds);
    recordStmt.run(upload.filename, upload.takenAt, upload.kind, size, path, Date.now());
    return { path: relative(dir, path), created: true };
  } catch (e) {
    if (open) await Promise.resolve(writer.end()).catch(() => 0);
    await rm(tmp, { force: true });
    throw e;
  }
}

export function syncedCount(): { files: number; last: number | null } {
  return db
    .query<{ files: number; last: number | null }, []>(`SELECT COUNT(*) files, MAX(synced_at) last FROM synced_files`)
    .get()!;
}
