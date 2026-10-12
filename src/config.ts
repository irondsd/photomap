import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { availableParallelism } from "node:os";

export const DATA_DIR = resolve(process.env.PHOTOMAP_DATA ?? join(import.meta.dir, "..", "data"));
export const DB_PATH = join(DATA_DIR, "index.sqlite");
export const THUMB_DIR = join(DATA_DIR, "thumbs");

export const PORT = Number(process.env.PORT ?? 3000);
export const HOST = process.env.HOST ?? "127.0.0.1";

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
