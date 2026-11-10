import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freeName, moveInto } from "./trash";

let dir: string;
let lib: string;
let trash: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "photomap-trash-"));
  lib = join(dir, "lib");
  trash = join(dir, "trash");
  await Bun.write(join(lib, "a.jpg"), "photo");
  await Bun.write(join(trash, ".keep"), "");
});
afterEach(async () => {
  await chmod(lib, 0o755).catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

test("moves the file into the trash folder, keeping its modified time", async () => {
  await utimes(join(lib, "a.jpg"), new Date(2020, 0, 1), new Date(2020, 0, 1));
  await moveInto(trash, join(lib, "a.jpg"));
  expect(await readdir(lib)).toEqual([]);
  expect(await Bun.file(join(trash, "a.jpg")).text()).toBe("photo");
  expect((await stat(join(trash, "a.jpg"))).mtime.getFullYear()).toBe(2020);
});

test("a name already in the trash gets the time appended", async () => {
  await Bun.write(join(trash, "a.jpg"), "older");
  const at = new Date(2026, 10, 9, 9, 5, 7);
  expect(freeName(trash, "a.jpg", at)).toBe(join(trash, "a 09.05.07.jpg"));
  await Bun.write(join(trash, "a 09.05.07.jpg"), "");
  expect(freeName(trash, "a.jpg", at)).toBe(join(trash, "a 09.05.07 2.jpg"));
  await moveInto(trash, join(lib, "a.jpg"));
  expect(await Bun.file(join(trash, "a.jpg")).text()).toBe("older");
});

test("a file in a read-only folder stays where it is", async () => {
  await chmod(lib, 0o555);
  expect(moveInto(trash, join(lib, "a.jpg"))).rejects.toThrow("read-only");
  expect(await readdir(lib)).toEqual(["a.jpg"]);
  expect(await readdir(trash)).toEqual([".keep"]);
});
