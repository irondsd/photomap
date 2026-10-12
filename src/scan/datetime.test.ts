import { test, expect, describe } from "bun:test";
import { parseDateString, parseOffset, offsetFromGps, dateFromFilename, resolveTime, zoneOffsetAtWall, relocalize } from "./datetime";

const wall = (s: string) => Date.parse(s + "Z") / 1000;

describe("parseDateString", () => {
  test("exif format", () => {
    expect(parseDateString("2019:06:12 14:22:01")).toEqual({ wall: wall("2019-06-12T14:22:01"), offset: null });
  });
  test("iso with offset and subseconds", () => {
    expect(parseDateString("2019-06-12T21:31:34.120+0300")).toEqual({ wall: wall("2019-06-12T21:31:34"), offset: 180 });
  });
  test("rejects zeros and roll-overs", () => {
    expect(parseDateString("0000:00:00 00:00:00")).toBeNull();
    expect(parseDateString("2019:02:31 10:00:00")).toBeNull();
    expect(parseDateString("    :  :     :  :  ")).toBeNull();
  });
});

test("parseOffset", () => {
  expect(parseOffset("+02:00")).toBe(120);
  expect(parseOffset("-0530")).toBe(-330);
  expect(parseOffset("Z")).toBe(0);
  expect(parseOffset("+25:00")).toBeNull();
});

test("offsetFromGps rounds to 15 minutes", () => {
  // Real sample: local 20:16:03, GPS 17:15:47 UTC → +3h (Moscow).
  expect(offsetFromGps(wall("2016-06-04T20:16:03"), "2016:06:04", [17, 15, 47])).toBe(180);
  // Crossing midnight: local 01:00 on the 5th, UTC 22:00 on the 4th.
  expect(offsetFromGps(wall("2016-06-05T01:00:00"), "2016:06:04", [22, 0, 0])).toBe(180);
  expect(offsetFromGps(wall("2016-06-04T20:16:03"), "2016:06:01", [17, 15, 47])).toBeNull();
});

test("zoneOffsetAtWall handles DST", () => {
  expect(zoneOffsetAtWall("Europe/Lisbon", wall("2023-07-01T12:00:00"))).toBe(60);
  expect(zoneOffsetAtWall("Europe/Lisbon", wall("2023-01-01T12:00:00"))).toBe(0);
  expect(zoneOffsetAtWall("Asia/Kolkata", wall("2023-01-01T12:00:00"))).toBe(330);
});

describe("dateFromFilename", () => {
  test.each([
    ["IMG_20190612_142201.jpg", "2019-06-12T14:22:01"],
    ["PXL_20230101_101010123.jpg", "2023-01-01T10:10:10"],
    ["Screen Recording 2019-06-12 at 21.31.19.mov", "2019-06-12T21:31:19"],
    ["IMG-20190612-WA0001.jpg", "2019-06-12T12:00:00"],
    ["2015-08-30 18.45.12.jpg", "2015-08-30T18:45:12"],
  ])("%s", (name, expected) => {
    expect(dateFromFilename(name)).toBe(wall(expected));
  });
  test("no date", () => {
    expect(dateFromFilename("DSC01234.JPG")).toBeNull();
    expect(dateFromFilename("photo_123456789.jpg")).toBeNull();
  });
});

describe("resolveTime priority", () => {
  const base = { name: "DSC0001.jpg", mtimeMs: Date.parse("2024-01-01T00:00:00Z") };
  test("embedded offset wins", () => {
    const r = resolveTime({ ...base, exif: { DateTimeOriginal: "2019:06:12 14:22:01", OffsetTimeOriginal: "+02:00" } });
    expect(r).toEqual({ local: wall("2019-06-12T14:22:01"), offset: 120, source: "exif+offset" });
  });
  test("geo time zone when no offset tags", () => {
    const r = resolveTime({ ...base, lat: 38.72, lon: -9.14, exif: { DateTimeOriginal: "2019:06:12 14:22:01" } });
    expect(r).toEqual({ local: wall("2019-06-12T14:22:01"), offset: 60, source: "exif+geotz" });
  });
  test("falls back to CreateDate when DateTimeOriginal is junk", () => {
    const r = resolveTime({ ...base, exif: { DateTimeOriginal: "0000:00:00 00:00:00", CreateDate: "2018:01:02 03:04:05" } });
    expect(r?.source).toBe("exif");
    expect(r?.local).toBe(wall("2018-01-02T03:04:05"));
  });
  test("apple video creationdate", () => {
    const r = resolveTime({ ...base, video: { creationDate: "2019-06-12T21:31:34+0300", creationTime: "2019-06-12T18:31:34.000000Z" } });
    expect(r).toEqual({ local: wall("2019-06-12T21:31:34"), offset: 180, source: "video+offset" });
  });
  test("video UTC creation_time converted with geo zone", () => {
    const r = resolveTime({ ...base, lat: 38.72, lon: -9.14, video: { creationTime: "2019-06-12T18:31:34.000000Z" } });
    expect(r).toEqual({ local: wall("2019-06-12T19:31:34"), offset: 60, source: "video" });
  });
  test("mtime last", () => {
    const r = resolveTime({ ...base, lat: 38.72, lon: -9.14 });
    expect(r).toEqual({ local: wall("2024-01-01T00:00:00"), offset: 0, source: "mtime" });
  });
});

describe("relocalize", () => {
  const ATHENS = [37.9715, 23.7257] as const;
  test("a video placed in the Mac's zone moves to the zone where it was shot", () => {
    // 12:00 UTC recorded as 09:00 (UTC−3, the Mac's zone) because the video had no location.
    const before = { local: wall("2019-07-14T09:00:00"), offset: -180, source: "video" as const };
    expect(relocalize(before, ...ATHENS)).toEqual({ local: wall("2019-07-14T15:00:00"), offset: 180, source: "video" });
  });
  test("EXIF wall time keeps its clock and gains the offset", () => {
    const before = { local: wall("2019-07-14T15:00:00"), offset: null, source: "exif" as const };
    expect(relocalize(before, ...ATHENS)).toEqual({ local: wall("2019-07-14T15:00:00"), offset: 180, source: "exif+geotz" });
  });
  test("removing the location undoes the EXIF offset", () => {
    const tagged = { local: wall("2019-07-14T15:00:00"), offset: 180, source: "exif+geotz" as const };
    expect(relocalize(tagged, null, null)).toEqual({ local: wall("2019-07-14T15:00:00"), offset: null, source: "exif" });
  });
  test("an embedded offset is never changed", () => {
    const t = { local: wall("2019-07-14T15:00:00"), offset: 180, source: "exif+offset" as const };
    expect(relocalize(t, -33.8568, 151.2153)).toEqual(t);
  });
});
