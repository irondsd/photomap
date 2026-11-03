import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATA_DIR, DEFAULT_SYNC_DIR } from "../config";
import { dockerProblem, mountOf, parseMountInfo, resetSyncDir, setSyncDir, syncDir, writableMounts } from "./folder";

// Resolved up front: on macOS the temp folder is behind a symlink, and the sync folder is stored resolved.
const base = realpathSync(mkdtempSync(join(tmpdir(), "photomap-syncdir-")));
afterAll(() => {
  resetSyncDir();
  rmSync(base, { recursive: true, force: true });
});

// Trimmed from a real OrbStack container: the overlay root, system mounts, the data folder,
// the read-only library and the writable Pictures share.
const MOUNTINFO = [
  "1001 1000 0:51 / / rw,relatime master:1 - overlay overlay rw",
  "1002 1001 0:53 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw",
  "1003 1001 0:54 / /dev rw,nosuid - tmpfs tmpfs rw,size=65536k",
  "1010 1001 0:40 /etc/hosts /etc/hosts rw,relatime - ext4 /dev/vdb1 rw",
  "1011 1001 0:60 /Users/me/dev/photomap/data /app/data rw,relatime - virtiofs mac rw",
  "1012 1001 0:60 /Users/me/Pictures /Users/me/Pictures rw,relatime - virtiofs mac rw",
  "1013 1012 0:60 /Users/me/Pictures/My\\040Photos /Users/me/Pictures/My\\040Photos ro,relatime - virtiofs mac rw",
].join("\n");
const mounts = parseMountInfo(MOUNTINFO);

describe("docker mounts", () => {
  test("parses mount points and decodes escaped spaces", () => {
    expect(mounts.map((m) => m.path)).toContain("/Users/me/Pictures/My Photos");
    expect(mounts.find((m) => m.path === "/Users/me/Pictures/My Photos")?.writable).toBe(false);
  });

  test("a path is on its deepest mount", () => {
    expect(mountOf("/Users/me/Pictures/My Photos/Phone", mounts)?.path).toBe("/Users/me/Pictures/My Photos");
    expect(mountOf("/Users/me/Pictures/Phone", mounts)?.path).toBe("/Users/me/Pictures");
    expect(mountOf("/Users/me/Pictures2", mounts)?.path).toBe("/");
  });

  test("suggests only shared, writable folders", () => {
    expect(writableMounts(mounts, "/app/data")).toEqual(["/Users/me/Pictures"]);
  });

  test("accepts folders on a writable share", () => {
    expect(dockerProblem("/Users/me/Pictures/Phone", mounts, "/app/data")).toBeNull();
    expect(dockerProblem("/Users/me/Pictures", mounts, "/app/data")).toBeNull();
  });

  test("refuses folders that would live inside the container", () => {
    for (const path of ["/home/bun/Phone", "/Users/other/Pictures", "/tmp/x", "/app/data/sync"]) {
      expect(dockerProblem(path, mounts, "/app/data")).toContain("can only write to folders shared");
    }
    expect(dockerProblem("/home/bun/Phone", mounts, "/app/data")).toContain("inside /Users/me/Pictures");
  });

  test("refuses read-only shares", () => {
    expect(dockerProblem("/Users/me/Pictures/My Photos/Phone", mounts, "/app/data")).toContain("read-only");
  });
});

describe("setSyncDir", () => {
  test("creates the folder and makes it the sync folder", () => {
    const dir = join(base, "Phone", "Pixel");
    expect(setSyncDir(dir)).toBe(dir);
    expect(existsSync(dir)).toBe(true);
    expect(syncDir()).toBe(setSyncDir(dir));
    expect(readdirSync(dir)).toEqual([]); // the write test cleans up after itself
  });

  test("expands ~", () => {
    const home = process.env.PHOTOMAP_HOME;
    process.env.PHOTOMAP_HOME = base;
    try {
      expect(setSyncDir("~/Tilde")).toBe(join(base, "Tilde"));
    } finally {
      if (home === undefined) delete process.env.PHOTOMAP_HOME;
      else process.env.PHOTOMAP_HOME = home;
    }
  });

  test("refuses relative paths, the data folder and unwritable folders", () => {
    expect(() => setSyncDir("Pictures/Phone")).toThrow("full path");
    expect(() => setSyncDir(join(DATA_DIR, "thumbs"))).toThrow("data folder");
    const locked = join(base, "locked");
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o500);
    try {
      expect(() => setSyncDir(locked)).toThrow("can't write");
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  test("a refused folder leaves the previous one in place", () => {
    const before = syncDir();
    expect(() => setSyncDir("relative")).toThrow();
    expect(syncDir()).toBe(before);
  });

  test("resetting goes back to the default", () => {
    resetSyncDir();
    expect(syncDir()).toBe(DEFAULT_SYNC_DIR);
  });
});
