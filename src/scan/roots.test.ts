import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { albumPhotoIds, createAlbum } from "../albums";
import { db, getPhoto, getRoot } from "../db";
import { joinSplitPaths, registerTarget, relinkRoot } from "./roots";

const existing = new Set(["/p/My Photos/CameraRoll", "/p/Other", "/p/A B C"]);
const exists = (p: string) => existing.has(p);

test("rejoins a path split on spaces", () => {
  expect(joinSplitPaths(["/p/My", "Photos/CameraRoll"], exists)).toEqual(["/p/My Photos/CameraRoll"]);
});

test("keeps separate valid paths separate", () => {
  expect(joinSplitPaths(["/p/Other", "/p/My", "Photos/CameraRoll"], exists)).toEqual([
    "/p/Other",
    "/p/My Photos/CameraRoll",
  ]);
});

test("multiple spaces", () => {
  expect(joinSplitPaths(["/p/A", "B", "C"], exists)).toEqual(["/p/A B C"]);
});

test("leaves unknown paths alone so they error clearly", () => {
  expect(joinSplitPaths(["/nope", "x"], exists)).toEqual(["/nope", "x"]);
});

test("relinking a moved folder preserves photo and album IDs", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "photomap-relink-")));
  db.run("SAVEPOINT relink_test");
  try {
    const original = join(dir, "Avant le déménagement");
    const moved = join(dir, "Moved");
    const other = join(dir, "Other");
    mkdirSync(original);
    mkdirSync(other);
    const { root } = registerTarget(original);
    const id = Number(
      db.run(
        `INSERT INTO photos (root_id, path, rel_dir, name, ext, kind, size, mtime, scan_gen, indexed_at)
         VALUES (?, ?, 'Trips', 'one.jpg', 'jpg', 'photo', 0, 0, 0, 0)`,
        [root.id, join(original, "Trips", "one.jpg")],
      ).lastInsertRowid,
    );
    const album = createAlbum("Trip", [id]);

    expect(() => relinkRoot(root, other)).toThrow("The original folder still exists");
    renameSync(original, moved);
    expect(relinkRoot(root, moved).id).toBe(root.id);
    expect(getRoot(root.id)?.path).toBe(moved);
    expect(getPhoto(id)?.path).toBe(join(moved, "Trips", "one.jpg"));
    expect(albumPhotoIds(album)).toEqual([id]);
  } finally {
    db.run("ROLLBACK TO relink_test");
    db.run("RELEASE relink_test");
    rmSync(dir, { recursive: true, force: true });
  }
});
