import { test, expect, describe } from "bun:test";
import { inferDates, originalName, sequenceOf, folderYear, type DateRow } from "./dates";

const H = 3600;
const T = Date.UTC(2012, 7, 7, 12) / 1000;
let id = 1;
const row = (name: string, t: number | null, source: string | null, extra: Partial<DateRow> = {}): DateRow => ({
  id: id++,
  dir: "Photos from 2012",
  name,
  t,
  offset: t == null ? null : 240,
  source,
  lat: null,
  mtimeMs: Date.UTC(2026, 9, 12),
  ...extra,
});
const undated = (name: string, extra: Partial<DateRow> = {}) => row(name, Date.UTC(2026, 9, 12) / 1000, "mtime", extra);
const machine = () => -180;
const fixFor = (rows: DateRow[], r: DateRow) => inferDates(rows, machine).find((f) => f.id === r.id);

test("name helpers", () => {
  expect(originalName("IMAG0170-edited(1).jpg")).toBe("imag0170.jpg");
  expect(originalName("000024(2).jpg")).toBe("000024.jpg");
  expect(sequenceOf("IMG_2586.JPG")).toEqual(["img_", 2586]);
  expect(sequenceOf("GOPR0123(1).jpg")).toEqual(["gopr", 123]);
  expect(sequenceOf("Snow Trees.jpg")).toBeNull();
  expect(folderYear("Photos from 2012")).toBe(2012);
  expect(folderYear("Trips/2015")).toBe(2015);
  expect(folderYear("Photos of me")).toBeNull();
});

test("an edited copy takes its original's date", () => {
  const orig = row("IMAG0170.jpg", T, "exif");
  const copy = undated("IMAG0170-edited.jpg");
  expect(fixFor([orig, copy], copy)).toMatchObject({ local: T, offset: 240, source: "original" });
});

describe("numbered neighbours", () => {
  test("interpolates within a day", () => {
    const a = row("IMAG0100.jpg", T, "exif");
    const b = row("IMAG0104.jpg", T + 4 * H, "exif");
    const p = undated("IMAG0101-edited.jpg");
    expect(fixFor([a, b, p], p)).toMatchObject({ local: T + H, source: "sequence" });
  });

  test("days apart: joins the nearer neighbour", () => {
    const a = row("IMAG0100.jpg", T, "exif");
    const b = row("IMAG0110.jpg", T + 10 * 24 * H, "exif");
    const p = undated("IMAG0108.jpg");
    expect(fixFor([a, b, p], p)).toMatchObject({ local: T + 10 * 24 * H, source: "sequence" });
  });

  test("a counter going backwards means two cameras: falls back to the folder year", () => {
    const a = row("IMG_0100.jpg", T + 24 * H, "exif");
    const b = row("IMG_0110.jpg", T, "exif");
    const p = undated("IMG_0105.jpg");
    expect(fixFor([a, b, p], p)?.source).toBe("folder");
  });

  test("one side only, if it's a close step", () => {
    const a = row("IMAG0169.jpg", T, "exif");
    const near = undated("IMAG0171.jpg");
    const far = undated("IMAG0190.jpg");
    const fixes = inferDates([a, near, far], machine);
    expect(fixes.find((f) => f.id === near.id)?.source).toBe("sequence");
    expect(fixes.find((f) => f.id === far.id)?.source).toBe("folder");
  });

  test("vague dates are never used as anchors", () => {
    const a = row("IMAG0100.jpg", T, "gps-date");
    const b = row("IMAG0102.jpg", T + H, "folder");
    const p = undated("IMAG0101.jpg");
    expect(fixFor([a, b, p], p)?.source).toBe("folder");
  });
});

test("the folder year overrules neighbours from another year (a collage made later)", () => {
  const a = row("IMAG0105.jpg", T, "exif", { dir: "Photos from 2018" });
  const b = row("IMAG0107.jpg", T + H, "exif", { dir: "Photos from 2018" });
  const p = undated("IMAG0106-COLLAGE.jpg", { dir: "Photos from 2018" });
  expect(fixFor([a, b, p], p)).toMatchObject({ source: "folder", local: Date.UTC(2018, 0, 1) / 1000 });
});

test("folder year sorts at the end of that year", () => {
  const p = undated("bwEbsPO.jpg");
  expect(fixFor([p], p)).toMatchObject({ local: Date.UTC(2012, 0, 1) / 1000, offset: null, source: "folder" });
});

test("an older guess goes back to the modified time when its evidence is gone", () => {
  const p = row("bwEbsPO.jpg", T, "sequence", { dir: "Misc" });
  expect(fixFor([p], p)).toMatchObject({ source: "mtime", offset: -180 });
});

test("filename timestamps borrow the zone of photos around them", () => {
  const utc = T;
  const nearby = row("IMG_1.jpg", utc + 2 * H + 240 * 60, "exif+offset"); // UTC+4, two hours later
  const fb = row("FB_IMG_1344340800000.jpg", utc - 180 * 60, "filename-utc", { offset: -180 }); // got the Mac's UTC−3
  expect(fixFor([nearby, fb], fb)).toMatchObject({ local: utc + 240 * 60, offset: 240 });
});
