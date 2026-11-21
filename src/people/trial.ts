import { statSync } from "node:fs";
import { join, resolve } from "node:path";

/** The experiment must never migrate or write to the normal library index. */
export function requireCopiedIndex() {
  const dir = process.env.PHOTOMAP_DATA;
  if (!dir) throw new Error("Set PHOTOMAP_DATA to the directory containing a copy of your index.sqlite.");
  const trial = statSync(resolve(dir, "index.sqlite"));
  const live = statSync(join(import.meta.dir, "../../data/index.sqlite"), { throwIfNoEntry: false });
  if (!trial.isFile() || (live && live.dev === trial.dev && live.ino === trial.ino)) {
    throw new Error("Use a separate copy of index.sqlite for face detection.");
  }
}
