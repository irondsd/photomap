import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { DATA_DIR, DEFAULT_SYNC_DIR } from "../config";
import { getMeta, setMeta } from "../db";
import { expandHome } from "../scan/roots";
import type { Layout } from "./receive";

const FOLDER_KEY = "sync_dir";
const LAYOUT_KEY = "sync_layout";

export const inDocker = existsSync("/.dockerenv");

/** Where files from the phone go: chosen in the Library, else `PHOTOMAP_SYNC_DIR`. */
export function syncDir(): string {
  return getMeta(FOLDER_KEY) || DEFAULT_SYNC_DIR;
}

export type Mount = { path: string; writable: boolean };

/** Mount points from /proc/self/mountinfo, whose fields escape spaces and the like as octal. */
export function parseMountInfo(text: string): Mount[] {
  const unescape = (s: string) => s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
  return text
    .split("\n")
    .map((line) => line.split(" "))
    .filter((f) => f.length > 5)
    .map((f) => ({ path: unescape(f[4]!), writable: f[5]!.split(",").includes("rw") }));
}

const within = (path: string, dir: string) => path === dir || path.startsWith(dir === "/" ? dir : dir + sep);

/** The mount a path is on: the deepest mount point that contains it. */
export function mountOf(path: string, mounts: Mount[]): Mount | undefined {
  let best: Mount | undefined;
  for (const m of mounts) if (within(path, m.path) && (!best || m.path.length > best.path.length)) best = m;
  return best;
}

/** Mounts that belong to the container itself, not folders shared from the computer. */
const SYSTEM = ["/", "/proc", "/sys", "/dev", "/etc", "/run", "/tmp", "/usr", "/app"];
const isSystem = (path: string) => SYSTEM.some((s) => (s === "/" ? path === "/" : within(path, s)));

/** Folders shared into the container that Photomap may write to, for suggesting. */
export function writableMounts(mounts: Mount[], dataDir = DATA_DIR): string[] {
  return mounts.filter((m) => m.writable && !isSystem(m.path) && !within(m.path, dataDir)).map((m) => m.path);
}

/**
 * Why a container can't use this folder, or null. Anything not on a shared folder would be
 * written inside the container and lost when it's rebuilt, which must never happen silently.
 */
export function dockerProblem(path: string, mounts: Mount[], dataDir = DATA_DIR): string | null {
  const mount = mountOf(path, mounts);
  if (!mount || isSystem(mount.path) || within(mount.path, dataDir)) {
    const options = writableMounts(mounts, dataDir);
    return (
      `Photomap runs in Docker and can only write to folders shared from your computer; ${path} isn't one. ` +
      (options.length ? `Pick a folder inside ${options.join(" or ")}, or ` : "") +
      "share it in compose.yaml (PHOTOMAP_SYNC_ROOT) and rebuild."
    );
  }
  if (!mount.writable) {
    return `${mount.path} is shared with Docker read-only. Pick another folder, or make that mount writable in compose.yaml.`;
  }
  return null;
}

function readMounts(): Mount[] {
  try {
    return parseMountInfo(readFileSync("/proc/self/mountinfo", "utf8"));
  } catch {
    return [];
  }
}

/** What the Library suggests when Photomap runs in Docker. */
export const dockerFolders = () => (inDocker ? writableMounts(readMounts()) : []);

/**
 * Why files can't be saved to the sync folder right now, or null. Only Docker can get here
 * without a folder having been checked: the default comes from PHOTOMAP_SYNC_DIR.
 */
export const folderProblem = () => (inDocker ? dockerProblem(syncDir(), readMounts()) : null);

/** Sorted into <year>/<month> folders (the default), or all in the sync folder itself. */
export function syncLayout(): Layout {
  return getMeta(LAYOUT_KEY) === "flat" ? "flat" : "month";
}

export function setSyncLayout(layout: Layout) {
  setMeta(LAYOUT_KEY, layout);
}

/** Checks a folder can hold synced files, creating it if needed, and makes it the sync folder. */
export function setSyncDir(input: string): string {
  const expanded = expandHome(input.trim());
  if (!expanded || !isAbsolute(expanded)) throw new Error("Use a full path, like ~/Pictures/Phone");
  let path = resolve(expanded);
  if (within(path, DATA_DIR)) throw new Error("That's Photomap's own data folder; pick a folder for photos.");
  if (inDocker) {
    const problem = dockerProblem(path, readMounts());
    if (problem) throw new Error(problem);
  }
  try {
    mkdirSync(path, { recursive: true });
    path = realpathSync(path);
    if (!statSync(path).isDirectory()) throw new Error(`${path} isn't a folder`);
  } catch (e) {
    throw new Error(`Couldn't create ${path}: ${(e as Error).message}`, { cause: e });
  }
  const probe = join(path, `.photomap-write-test-${crypto.randomUUID()}`);
  try {
    writeFileSync(probe, "");
    rmSync(probe);
  } catch (e) {
    throw new Error(`Photomap can't write to ${path}.`, { cause: e });
  }
  setMeta(FOLDER_KEY, path);
  return path;
}

/** Back to `PHOTOMAP_SYNC_DIR`. */
export function resetSyncDir() {
  setMeta(FOLDER_KEY, "");
}
