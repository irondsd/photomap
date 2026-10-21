import { test, expect, describe } from "bun:test";
import {
  parseDateString,
  parseOffset,
  offsetFromGps,
  dateFromFilename,
  epochFromFilename,
  resolveTime,
  zoneOffsetAtWall,
  relocalize,
} from "./datetime";

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
    const r = resolveTime({
      ...base,
      exif: { DateTimeOriginal: "0000:00:00 00:00:00", CreateDate: "2018:01:02 03:04:05" },
    });
    expect(r?.source).toBe("exif");
    expect(r?.local).toBe(wall("2018-01-02T03:04:05"));
  });
  test("apple video creationdate", () => {
    const r = resolveTime({
      ...base,
      video: { creationDate: "2019-06-12T21:31:34+0300", creationTime: "2019-06-12T18:31:34.000000Z" },
    });
    expect(r).toEqual({ local: wall("2019-06-12T21:31:34"), offset: 180, source: "video+offset" });
  });
  test("video UTC creation_time converted with geo zone", () => {
    const r = resolveTime({ ...base, lat: 38.72, lon: -9.14, video: { creationTime: "2019-06-12T18:31:34.000000Z" } });
    expect(r).toEqual({ local: wall("2019-06-12T19:31:34"), offset: 60, source: "video" });
  });
  test("a GoPro's creation_time is its local clock, despite the Z", () => {
    // GOPR0303 in Peru: the JPG shot just before it says 11:15:05 local.
    const video = { creationTime: "2017-12-19T11:15:51.000000Z", localClock: true };
    expect(resolveTime({ ...base, lat: -13.8681, lon: -71.303, video })).toEqual({
      local: wall("2017-12-19T11:15:51"),
      offset: -300,
      source: "video-local",
    });
    expect(resolveTime({ ...base, video })).toEqual({
      local: wall("2017-12-19T11:15:51"),
      offset: null,
      source: "video-local",
    });
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
    expect(relocalize(before, ...ATHENS)).toEqual({
      local: wall("2019-07-14T15:00:00"),
      offset: 180,
      source: "exif+geotz",
    });
  });
  test("a GoPro clock keeps its wall time and takes the offset where it's placed", () => {
    const before = { local: wall("2019-07-14T15:00:00"), offset: null, source: "video-local" as const };
    const placed = { local: wall("2019-07-14T15:00:00"), offset: 180, source: "video-local" as const };
    expect(relocalize(before, ...ATHENS)).toEqual(placed);
    expect(relocalize(placed, null, null)).toEqual(before);
  });
  test("removing the location undoes the EXIF offset", () => {
    const tagged = { local: wall("2019-07-14T15:00:00"), offset: 180, source: "exif+geotz" as const };
    expect(relocalize(tagged, null, null)).toEqual({
      local: wall("2019-07-14T15:00:00"),
      offset: null,
      source: "exif",
    });
  });
  test("an embedded offset is never changed", () => {
    const t = { local: wall("2019-07-14T15:00:00"), offset: 180, source: "exif+offset" as const };
    expect(relocalize(t, -33.8568, 151.2153)).toEqual(t);
  });
});

describe("dates without a camera clock", () => {
  test("millisecond timestamps in file names", () => {
    expect(epochFromFilename("FB_IMG_1501315576710.jpg")).toBe(1501315576);
    expect(epochFromFilename("FaceApp_1587812345678.jpg")).toBe(1587812345);
    // Facebook sometimes appends more digits.
    expect(epochFromFilename("FB_IMG_15092431064951829.jpg")).toBe(1509243106);
    expect(epochFromFilename("IMG_2586.JPG")).toBeNull();
    expect(epochFromFilename("1000000000000.jpg")).toBeNull(); // 2001: more likely an id
  });

  test("GPS clock is used when there's no camera date", () => {
    // 12:00:00 UTC in Paris in July = 14:00 local (UTC+2).
    const r = resolveTime({
      name: "x.jpg",
      mtimeMs: 0,
      lat: 48.8584,
      lon: 2.2945,
      exif: { GPSDateStamp: "2019:07:14", GPSTimeStamp: [12, 0, 0] },
    });
    expect(r).toEqual({ local: wall("2019-07-14T14:00:00"), offset: 120, source: "gps" });
  });

  test("a camera date still wins over the GPS clock", () => {
    const r = resolveTime({
      name: "x.jpg",
      mtimeMs: 0,
      exif: { DateTimeOriginal: "2019:07:14 14:00:05", GPSDateStamp: "2019:07:14", GPSTimeStamp: [12, 0, 0] },
    });
    expect(r?.source).toBe("exif+gps");
  });

  test("filename timestamp beats the file's modified time", () => {
    const r = resolveTime({
      name: "FB_IMG_1501315576710.jpg",
      mtimeMs: Date.parse("2026-10-12T00:00:00Z"),
      lat: 48.8584,
      lon: 2.2945,
    });
    expect(r).toEqual({ local: 1501315576 + 120 * 60, offset: 120, source: "filename-utc" });
  });
});

test("a GPS date with a garbage time still gives the day", () => {
  // HTC Desire S: the time field holds a copy of the longitude.
  const r = resolveTime({
    name: "IMAG0178-edited.jpg",
    mtimeMs: 0,
    lat: 56.84,
    lon: 35.91,
    exif: { GPSDateStamp: "2012:08:07", GPSTimeStamp: [35, 54, 50.43] },
  });
  expect(r).toEqual({ local: wall("2012-08-07T12:00:00"), offset: 240, source: "gps-date" });
});

describe("placeholder dates", () => {
  test("Picasa's 2002-12-08 placeholder loses to the date in the file name", () => {
    const r = resolveTime({
      name: "IMG_20161203_193220.jpg",
      mtimeMs: 0,
      exif: { CreateDate: "2002:12:08 12:00:00", ModifyDate: "2016:10:06 19:27:05" },
    });
    expect(r?.source).toBe("filename");
    expect(r?.local).toBe(wall("2016-12-03T19:32:20"));
  });

  test("the file name also beats a real-looking modify date when there's no capture date", () => {
    const r = resolveTime({ name: "IMG_20130218_141928.jpg", mtimeMs: 0, exif: { ModifyDate: "2013:03:01 10:00:00" } });
    expect(r?.local).toBe(wall("2013-02-18T14:19:28"));
  });

  test("a capture date still beats the file name", () => {
    const r = resolveTime({
      name: "IMG_20161203_193220.jpg",
      mtimeMs: 0,
      exif: { DateTimeOriginal: "2016:12:03 19:32:21" },
    });
    expect(r?.source).toBe("exif");
  });

  test("the placeholder alone is ignored entirely", () => {
    const r = resolveTime({
      name: "DSC0001.jpg",
      mtimeMs: Date.parse("2020-01-01T00:00:00Z"),
      exif: { CreateDate: "2002:12:08 12:00:00" },
    });
    expect(r?.source).toBe("mtime");
  });
});
