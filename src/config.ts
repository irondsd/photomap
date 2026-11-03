import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { availableParallelism, homedir } from "node:os";

export const DATA_DIR = resolve(process.env.PHOTOMAP_DATA ?? join(import.meta.dir, "..", "data"));
export const DB_PATH = join(DATA_DIR, "index.sqlite");
export const THUMB_DIR = join(DATA_DIR, "thumbs");

export const PORT = Number(process.env.PORT ?? 4747);
export const HOST = process.env.HOST ?? "127.0.0.1";

/** Phone sync listens on the local network on its own port, serving only the token-protected sync API. */
export const SYNC_PORT = Number(process.env.PHOTOMAP_SYNC_PORT ?? PORT + 1);
/**
 * Where files from the phone app are written, as <year>/<month>/<name>, until another folder is
 * chosen in the Library. Indexed like any other folder.
 */
export const DEFAULT_SYNC_DIR = resolve(
  process.env.PHOTOMAP_SYNC_DIR ?? join(process.env.PHOTOMAP_HOME ?? homedir(), "Pictures", "Photomap Sync"),
);

export const CPUS = availableParallelism();

mkdirSync(THUMB_DIR, { recursive: true });

export const IMAGE_EXT = new Set(["jpg", "jpeg", "heic", "heif", "png", "tif", "tiff", "webp", "avif"]);
export const RAW_EXT = new Set(["dng", "cr2", "cr3", "nef", "arw", "raf", "orf", "rw2", "pef", "srw"]);
export const VIDEO_EXT = new Set(["mp4", "mov", "m4v", "3gp", "avi", "mkv"]);

export type Kind = "photo" | "raw" | "video";

export function kindOf(ext: string): Kind | null {
  if (IMAGE_EXT.has(ext)) return "photo";
  if (RAW_EXT.has(ext)) return "raw";
  if (VIDEO_EXT.has(ext)) return "video";
  return null;
}

/** Directory names never descended into. */
export function skipDir(name: string): boolean {
  return (
    name.startsWith(".") ||
    name === "@eaDir" ||
    name === "#recycle" ||
    name === "node_modules" ||
    name.endsWith(".photoslibrary") ||
    name.endsWith(".lrdata")
  );
}
