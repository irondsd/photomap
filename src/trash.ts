import { existsSync } from "node:fs";
import { access, constants, copyFile, rename, stat, unlink, utimes } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

/**
 * A Trash folder to move files into ourselves, for when the system's Trash is out of reach: in Docker,
 * the Mac's ~/.Trash mounted into the container. macOS won't let the container list it, but moving into it works.
 */
const TRASH_DIR = process.env.PHOTOMAP_TRASH_DIR || null;

/** The system's own Trash command for one file, or null when there is none. */
function trashCommand(path: string): string[] | null {
  if (process.platform === "darwin") {
    // macOS 14+ ships one; older versions go through Finder.
    if (existsSync("/usr/bin/trash")) return ["/usr/bin/trash", path];
    return ["osascript", "-e", 'tell application "Finder" to delete POSIX file (system attribute "PM_TRASH")'];
  }
  if (process.platform === "win32") {
    return [
      "powershell",
      "-NoProfile",
      "-Command",
      "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:PM_TRASH, 'OnlyErrorDialogs', 'SendToRecycleBin')",
    ];
  }
  return Bun.which("gio") ? ["gio", "trash", path] : null;
}

async function systemTrash(path: string, cmd: string[]) {
  const proc = Bun.spawn(cmd, { env: { ...process.env, PM_TRASH: path }, stdout: "ignore", stderr: "pipe" });
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) {
    // macOS's trash prints a whole NSError; its quoted description is the readable part.
    const reason = /Code=-?\d+ "([^"]+)"/.exec(err)?.[1] ?? err.trim().split("\n").at(-1);
    throw new Error(reason || `exit code ${code}`);
  }
}

/** A name not yet taken in `dir`; like Finder, a clash gets the time appended ("IMG_1234 09.21.22.jpg"). */
export function freeName(dir: string, name: string, now = new Date()): string {
  if (!existsSync(join(dir, name))) return join(dir, name);
  const ext = extname(name);
  const base = name.slice(0, name.length - ext.length);
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()].map((n) => String(n).padStart(2, "0")).join(".");
  for (let i = 1; ; i++) {
    const candidate = join(dir, `${base} ${time}${i > 1 ? ` ${i}` : ""}${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
}

/** Moves a file into `dir`, copying when it's on another device (another bind mount). */
export async function moveInto(dir: string, path: string): Promise<void> {
  // Before copying what may be a large video: the file has to be removable from where it is.
  try {
    await access(dirname(path), constants.W_OK);
  } catch {
    throw new Error("the folder it's in is read-only");
  }
  if (!existsSync(dir)) throw new Error(`the Trash folder ${dir} isn't there`);
  const dest = freeName(dir, basename(path));
  try {
    await rename(path, dest);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
  }
  await copyFile(path, dest, constants.COPYFILE_EXCL);
  try {
    const s = await stat(path);
    await utimes(dest, s.atime, s.mtime);
    await unlink(path);
  } catch (err) {
    // Not both: the file stays where it was.
    await unlink(dest).catch(() => {});
    throw err;
  }
}

/** Moves a file to the Trash (the Recycle Bin on Windows), where it can be put back from. */
export async function moveToTrash(path: string): Promise<void> {
  if (TRASH_DIR) return moveInto(TRASH_DIR, path);
  const cmd = trashCommand(path);
  if (!cmd) throw new Error("this system has no Trash Photomap can use (set PHOTOMAP_TRASH_DIR)");
  return systemTrash(path, cmd);
}
