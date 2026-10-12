import { resolve, relative, sep } from "node:path";
import { statSync, realpathSync } from "node:fs";
import { addRoot, db, getRoots, removeRoot, type RootRow } from "../db";

/** What to scan: a registered root, optionally only one subfolder of it. */
export interface ScanTarget {
  root: RootRow;
  subdir: string | null;
}

export const expandHome = (p: string) => p.replace(/^~(?=$|\/)/, process.env.HOME ?? "~");

export function normalizeFolder(input: string): string {
  let path: string;
  try {
    path = realpathSync(resolve(expandHome(input)));
  } catch {
    throw new Error(`Folder not found: ${input}`);
  }
  if (!statSync(path).isDirectory()) throw new Error(`Not a folder: ${path}`);
  return path;
}

/**
 * Resolves a folder to scan. A file always belongs to exactly one root:
 * - a subfolder of a registered root scans just that part of the root;
 * - a parent of registered roots becomes a root and absorbs them (index entries are kept).
 */
export function registerTarget(input: string): ScanTarget {
  const path = normalizeFolder(input);
  const roots = getRoots();

  for (const r of roots) {
    if (r.path === path) return { root: r, subdir: null };
    if (path.startsWith(r.path + sep)) return { root: r, subdir: path };
  }

  const children = roots.filter((r) => r.path.startsWith(path + sep));
  if (!children.length) return { root: addRoot(path), subdir: null };

  return {
    root: db.transaction(() => {
      const root = addRoot(path);
      for (const child of children) {
        const prefix = relative(path, child.path);
        db.run(
          `UPDATE photos SET root_id = ?, rel_dir = ? || CASE WHEN rel_dir = '' THEN '' ELSE '/' || rel_dir END WHERE root_id = ?`,
          [root.id, prefix, child.id],
        );
        removeRoot(child.id);
      }
      return root;
    })(),
    subdir: null,
  };
}

/**
 * An unquoted path with spaces arrives split into several arguments
 * (`~/Pictures/My Photos` → "…/My", "Photos"). Rejoin pieces when the joined path exists.
 */
export function joinSplitPaths(parts: string[], exists: (p: string) => boolean): string[] {
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    let joined = parts[i]!;
    if (!exists(joined)) {
      for (let j = i + 1; j < parts.length; j++) {
        const candidate = parts.slice(i, j + 1).join(" ");
        if (exists(candidate)) {
          joined = candidate;
          i = j;
          break;
        }
      }
    }
    out.push(joined);
  }
  return out;
}
