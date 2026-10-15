import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { DB_PATH } from "../config";
import { addRoot, db, getPhoto, removeRoot, upsertPhoto } from "../db";
import { inferDates, type DateRow } from "./dates";
import { relocalize } from "./datetime";
import { extract } from "./extract";
import { applyDateInference } from "./fixDates";
import { restoreFromFile, setLocation } from "./locate";
import { keepManualDate, parseManualDate, resetManualDates, setManualDate } from "./manualDates";

// The index is a throwaway one (see test-setup.ts); refuse to write to anything else.
if (!process.env.PHOTOMAP_DATA || !DB_PATH.startsWith(process.env.PHOTOMAP_DATA) || !DB_PATH.startsWith(tmpdir())) {
  throw new Error(`refusing to run against ${DB_PATH}`);
}
const dir = mkdtempSync(join(tmpdir(), "photomap-dates-"));

const utc = (s: string) => Date.parse(s + "Z") / 1000;
const PARIS = { lat: 48.8584, lon: 2.2945 };

let photoId = 0;
let rootId = 0;
beforeAll(async () => {
  // No date anywhere in the file: only the folder name says when it was taken.
  const root = join(dir, "library");
  mkdirSync(join(root, "2020"), { recursive: true });
  const path = join(root, "2020", "IMG_0001.jpg");
  await sharp({ create: { width: 8, height: 6, channels: 3, background: "#888" } })
    .jpeg()
    .toFile(path);
  const r = addRoot(root);
  rootId = r.id;
  const st = Bun.file(path);
  const mtime = st.lastModified;
  upsertPhoto({
    root_id: r.id,
    path,
    rel_dir: "2020",
    name: "IMG_0001.jpg",
    ext: "jpg",
    kind: "photo",
    size: st.size,
    mtime,
    scan_gen: 1,
    ...(await extract(path, "photo", "IMG_0001.jpg", mtime)),
  });
  photoId = db.query<{ id: number }, [string]>(`SELECT id FROM photos WHERE path = ?`).get(path)!.id;
  await applyDateInference();
});

afterAll(() => {
  removeRoot(rootId);
  rmSync(dir, { recursive: true, force: true });
});

test("a date with a time, or only a day (kept at noon)", () => {
  expect(parseManualDate("2019-06-12", "14:30")).toEqual({ local: utc("2019-06-12T14:30:00"), source: "manual" });
  expect(parseManualDate("2019-06-12", "14:30:05")).toEqual({ local: utc("2019-06-12T14:30:05"), source: "manual" });
  expect(parseManualDate("2019-06-12")).toEqual({ local: utc("2019-06-12T12:00:00"), source: "manual-date" });
  expect(parseManualDate("2019-06-12", "")).toEqual({ local: utc("2019-06-12T12:00:00"), source: "manual-date" });
});

test("impossible dates and times are refused", () => {
  expect(parseManualDate("2021-02-30")).toBeNull();
  expect(parseManualDate("2019-06-12", "25:00")).toBeNull();
  expect(parseManualDate("2019-06-12", "2pm")).toBeNull();
  expect(parseManualDate("12/06/2019")).toBeNull();
  expect(parseManualDate("3019-01-01")).toBeNull();
  expect(parseManualDate(undefined)).toBeNull();
});

test("a hand-set wall time keeps its value and takes the zone of the location", () => {
  const t = relocalize({ local: utc("2019-06-12T14:30:00"), offset: null, source: "manual" }, PARIS.lat, PARIS.lon);
  expect(t).toEqual({ local: utc("2019-06-12T14:30:00"), offset: 120, source: "manual" });
  expect(relocalize(t, null, null)).toEqual({ local: utc("2019-06-12T14:30:00"), offset: null, source: "manual" });
});

test("inference never replaces a hand-set date, nor learns from one", () => {
  const row = (id: number, name: string, t: number | null, source: string | null): DateRow => ({
    id,
    dir: "/photos/2020",
    name,
    t,
    offset: null,
    source,
    lat: null,
    mtimeMs: 0,
  });
  const fixes = inferDates(
    [
      // Contradicts the folder's year, which would replace a camera date.
      row(1, "IMG_0001.jpg", utc("2015-03-01T10:00:00"), "manual"),
      row(2, "IMG_0002.jpg", utc("2015-03-01T12:00:00"), "manual-date"),
      // Its numbered neighbours are both hand-dated: still only the folder year.
      row(3, "IMG_0003.jpg", null, "mtime"),
      row(4, "IMG_0004.jpg", utc("2015-03-01T11:00:00"), "manual"),
    ],
    () => 0,
  );
  expect(fixes.map((f) => [f.id, f.source])).toEqual([[3, "folder"]]);
});

test("the photo starts with only the folder's year", () => {
  const p = getPhoto(photoId)!;
  expect(p.time_source).toBe("folder");
  expect(p.taken_local).toBe(utc("2020-01-01T00:00:00"));
});

test("setting a date by hand survives date inference and a rescan", async () => {
  expect(setManualDate(photoId, parseManualDate("2020-07-14", "18:45")!)).toBe(true);
  expect(setManualDate(999_999, parseManualDate("2020-07-14")!)).toBe(false);
  let p = getPhoto(photoId)!;
  expect([p.taken_local, p.tz_offset, p.time_source]).toEqual([utc("2020-07-14T18:45:00"), null, "manual"]);

  await applyDateInference();
  p = getPhoto(photoId)!;
  expect([p.taken_local, p.time_source]).toEqual([utc("2020-07-14T18:45:00"), "manual"]);

  // What the scanner does with a file that changed: re-extract, keep the hand-set date.
  const meta = keepManualDate(await extract(p.path, p.kind, p.name, p.mtime), p);
  expect([meta.taken_local, meta.time_source]).toEqual([utc("2020-07-14T18:45:00"), "manual"]);
});

test("a location sets the zone of a hand-set date, and resetting the location keeps the date", async () => {
  setLocation(photoId, { ...PARIS, source: "manual" });
  let p = getPhoto(photoId)!;
  expect([p.taken_local, p.tz_offset, p.time_source]).toEqual([utc("2020-07-14T18:45:00"), 120, "manual"]);

  await restoreFromFile(photoId);
  p = getPhoto(photoId)!;
  expect([p.lat, p.taken_local, p.tz_offset, p.time_source]).toEqual([
    null,
    utc("2020-07-14T18:45:00"),
    null,
    "manual",
  ]);
});

test("resetting goes back to the date from the folder", async () => {
  setManualDate(photoId, parseManualDate("2020-07-14")!);
  expect(getPhoto(photoId)!.time_source).toBe("manual-date");

  expect(await resetManualDates([photoId, 999_999])).toEqual([photoId]);
  const p = getPhoto(photoId)!;
  expect([p.taken_local, p.time_source]).toEqual([utc("2020-01-01T00:00:00"), "folder"]);

  // Nothing left to reset.
  expect(await resetManualDates([photoId])).toEqual([]);
});
