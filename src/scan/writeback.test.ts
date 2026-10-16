import { test, expect, describe, afterAll } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { extract, type Extracted } from "./extract";
import { exifDate, exifOffset, exiftoolArgs, pendingChange, writeFile, type WritebackRow } from "./writeback";

const utc = (s: string) => Date.parse(s + "Z") / 1000;
const PARIS = { lat: 48.8584, lon: 2.2945 };

const file = (over: Partial<Extracted> = {}): Extracted => ({
  taken_local: null,
  tz_offset: null,
  time_source: null,
  lat: null,
  lon: null,
  alt: null,
  gps_source: null,
  width: null,
  height: null,
  orientation: null,
  duration: null,
  make: null,
  model: null,
  lens: null,
  iso: null,
  fnumber: null,
  exposure: null,
  focal: null,
  country_code: null,
  country: null,
  error: null,
  ...over,
});
const row = (over: Partial<WritebackRow> = {}): WritebackRow => ({
  id: 1,
  path: "/x/IMG_0001.jpg",
  name: "IMG_0001.jpg",
  kind: "photo",
  taken_local: null,
  tz_offset: null,
  time_source: null,
  lat: null,
  lon: null,
  gps_source: null,
  ...over,
});

describe("pendingChange", () => {
  test("writes a hand-set location the file doesn't have", () => {
    const r = row({ ...PARIS, gps_source: "manual" });
    expect(pendingChange(r, file())).toEqual({ location: PARIS });
    expect(pendingChange(r, file({ lat: 10, lon: 10 }))).toEqual({ location: PARIS });
    expect(pendingChange(r, file({ lat: PARIS.lat + 3e-5, lon: PARIS.lon - 3e-5 }))).toBeNull();
  });

  test("never writes the file's own or inferred locations", () => {
    expect(pendingChange(row({ ...PARIS, gps_source: "exif" }), file())).toBeNull();
    expect(pendingChange(row({ ...PARIS, gps_source: "inferred:burst" }), file())).toBeNull();
  });

  test("writes a hand-set date unless the file's metadata already has it", () => {
    const t = utc("2019-07-14T15:00:00");
    const r = row({ taken_local: t, tz_offset: 120, time_source: "manual" });
    expect(pendingChange(r, file())).toEqual({ date: { local: t, offset: 120 } });
    expect(pendingChange(r, file({ taken_local: t, tz_offset: 120, time_source: "exif+offset" }))).toBeNull();
    // Same time, but another offset.
    expect(pendingChange(r, file({ taken_local: t, tz_offset: 60, time_source: "exif+offset" }))).not.toBeNull();
    // Same time, but only from the file name: nothing in the metadata yet.
    expect(pendingChange(r, file({ taken_local: t, tz_offset: 120, time_source: "filename" }))).not.toBeNull();
    // No known offset: the file's own one is fine.
    const noZone = row({ taken_local: t, tz_offset: null, time_source: "manual-date" });
    expect(pendingChange(noZone, file({ taken_local: t, tz_offset: 60, time_source: "exif+offset" }))).toBeNull();
  });

  test("videos count their QuickTime dates as metadata", () => {
    const t = utc("2019-07-14T15:00:00");
    const r = row({ kind: "video", taken_local: t, tz_offset: 120, time_source: "manual" });
    expect(pendingChange(r, file({ taken_local: t, tz_offset: 120, time_source: "video+offset" }))).toBeNull();
    expect(pendingChange(r, file({ taken_local: t, tz_offset: 120, time_source: "exif+offset" }))).not.toBeNull();
  });

  test("never writes inferred dates", () => {
    const r = row({ taken_local: utc("2012-06-01T12:00:00"), time_source: "folder" });
    expect(pendingChange(r, file())).toBeNull();
  });
});

describe("exiftool arguments", () => {
  test("formats dates and offsets", () => {
    expect(exifDate(utc("2019-07-04T05:06:07"))).toBe("2019:07:04 05:06:07");
    expect(exifOffset(120)).toBe("+02:00");
    expect(exifOffset(-330)).toBe("-05:30");
    expect(exifOffset(0)).toBe("+00:00");
  });

  test("photos get EXIF GPS with refs, dates and offsets", () => {
    const args = exiftoolArgs(
      "photo",
      { location: { lat: -33.8568, lon: -151.2153 }, date: { local: utc("2019-07-14T15:00:00"), offset: 600 } },
      false,
    );
    expect(args).toEqual([
      "-P",
      "-EXIF:GPSLatitude=33.8568",
      "-EXIF:GPSLatitudeRef=S",
      "-EXIF:GPSLongitude=151.2153",
      "-EXIF:GPSLongitudeRef=W",
      "-EXIF:GPSAltitude=",
      "-EXIF:GPSAltitudeRef=",
      "-EXIF:DateTimeOriginal=2019:07:14 15:00:00",
      "-EXIF:CreateDate=2019:07:14 15:00:00",
      "-EXIF:OffsetTimeOriginal=+10:00",
      "-EXIF:OffsetTimeDigitized=+10:00",
    ]);
    expect(exiftoolArgs("photo", { date: { local: 0, offset: null } }, true)).toEqual([
      "-P",
      "-overwrite_original",
      "-EXIF:DateTimeOriginal=1970:01:01 00:00:00",
      "-EXIF:CreateDate=1970:01:01 00:00:00",
    ]);
  });

  test("videos get QuickTime tags, with UTC header dates only when the offset is known", () => {
    const local = utc("2019-07-14T15:00:00");
    expect(exiftoolArgs("video", { location: PARIS, date: { local, offset: 120 } }, false)).toEqual([
      "-P",
      "-Keys:GPSCoordinates=48.8584, 2.2945",
      "-UserData:GPSCoordinates=48.8584, 2.2945",
      "-Keys:CreationDate=2019:07:14 15:00:00+02:00",
      "-QuickTime:CreateDate=2019:07:14 13:00:00",
      "-QuickTime:TrackCreateDate=2019:07:14 13:00:00",
      "-QuickTime:MediaCreateDate=2019:07:14 13:00:00",
    ]);
    expect(exiftoolArgs("video", { date: { local, offset: null } }, false)).toEqual([
      "-P",
      "-Keys:CreationDate=2019:07:14 15:00:00",
    ]);
  });
});

// Round trip through the real exiftool and the scanner's own extractor.
const dir = mkdtempSync(join(tmpdir(), "photomap-writeback-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const hasExiftool = !!Bun.which("exiftool");
const hasFfmpeg = !!Bun.which("ffmpeg");

test.skipIf(!hasExiftool)("a written photo reads back as what the index says", async () => {
  const path = join(dir, "IMG_0001.jpg");
  await sharp({ create: { width: 8, height: 6, channels: 3, background: "#888" } })
    .jpeg()
    .withExif({ IFD0: { Make: "Test" }, IFD2: { DateTimeOriginal: "2003:01:01 00:00:00" } })
    .toFile(path);
  const mtime = statSync(path).mtimeMs;
  const r = row({
    path,
    lat: -33.8568,
    lon: 151.2153,
    gps_source: "manual",
    taken_local: utc("2019-07-14T15:00:30"),
    tz_offset: 600,
    time_source: "manual",
  });
  const change = pendingChange(r, await extract(path, "photo", r.name, mtime))!;
  expect(change.date && change.location).toBeTruthy();

  expect(await writeFile(path, exiftoolArgs("photo", change, false))).toBeNull();
  expect(Math.round(statSync(path).mtimeMs)).toBe(Math.round(mtime)); // what the scanner stores
  expect(existsSync(path + "_original")).toBe(true);

  const after = await extract(path, "photo", r.name, mtime);
  expect(pendingChange(r, after)).toBeNull();
  expect(after).toMatchObject({ time_source: "exif+offset", tz_offset: 600, gps_source: "exif", country_code: "AU" });
  expect(after.lat).toBeCloseTo(-33.8568, 6);
  expect(after.lon).toBeCloseTo(151.2153, 6);
});

test.skipIf(!hasExiftool || !hasFfmpeg)("a written video reads back as what the index says", async () => {
  const src = join(dir, "src.mp4");
  await Bun.$`ffmpeg -v quiet -f lavfi -i color=c=gray:s=16x16:d=0.1 -c:v libx264 -pix_fmt yuv420p ${src}`;
  for (const offset of [120, null]) {
    const path = join(dir, `VID_${offset ?? "nozone"}.mp4`);
    copyFileSync(src, path);
    const r = row({
      path,
      name: "VID.mp4",
      kind: "video",
      ...PARIS,
      gps_source: "manual",
      taken_local: utc("2019-07-14T15:00:00"),
      tz_offset: offset,
      time_source: "manual",
    });
    const mtime = statSync(path).mtimeMs;
    const change = pendingChange(r, await extract(path, "video", r.name, mtime))!;
    expect(await writeFile(path, exiftoolArgs("video", change, true))).toBeNull();
    expect(existsSync(path + "_original")).toBe(false);
    const after = await extract(path, "video", r.name, mtime);
    expect(pendingChange(r, after)).toBeNull();
    expect(after.gps_source).toBe("video");
  }
});

test.skipIf(!hasExiftool)("reports files exiftool can't write", async () => {
  const path = join(dir, "broken.jpg");
  await Bun.write(path, "not a jpeg");
  expect(await writeFile(path, exiftoolArgs("photo", { location: PARIS }, true))).toMatch(/JPEG|JPG|valid/i);
});
