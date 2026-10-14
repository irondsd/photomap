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

describe("editor save time", () => {
  const saved = Date.UTC(2012, 7, 6, 9, 53) / 1000;

  test("used when there's nothing better", () => {
    const p = undated("IMG_4718.jpg", { savedAt: saved });
    expect(fixFor([p], p)).toMatchObject({ source: "edited", local: saved + -180 * 60 });
  });

  test("beats numbered neighbours that are far apart", () => {
    const a = row("IMG_4600.jpg", Date.UTC(2012, 5, 10) / 1000, "exif");
    const b = row("IMG_4800.jpg", Date.UTC(2012, 9, 1) / 1000, "exif");
    const p = undated("IMG_4718.jpg", { savedAt: saved });
    expect(fixFor([a, b, p], p)?.source).toBe("edited");
  });

  test("a rough neighbour estimate shortly before the save is kept", () => {
    const a = row("IMG_4700.jpg", saved - 7 * 24 * H, "exif"); // a week before the save
    const b = row("IMG_4800.jpg", saved + 60 * 24 * H, "exif");
    const p = undated("IMG_4710.jpg", { savedAt: saved });
    expect(fixFor([a, b, p], p)).toMatchObject({ source: "sequence", local: saved - 7 * 24 * H });
  });

  test("loses to numbered neighbours from the same day", () => {
    const a = row("IMG_4717.jpg", T, "exif");
    const b = row("IMG_4719.jpg", T + H, "exif");
    const p = undated("IMG_4718.jpg", { savedAt: saved });
    expect(fixFor([a, b, p], p)?.source).toBe("sequence");
  });

  test("ignored when it doesn't match the folder's year (re-saved years later)", () => {
    const p = undated("IMG_4718.jpg", { savedAt: Date.UTC(2019, 0, 1) / 1000 });
    expect(fixFor([p], p)?.source).toBe("folder");
  });
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

describe("dates that contradict their folder", () => {
  const day = 24 * H;

  test("a correctly dated twin of the same shot wins (a TIF converted years later)", () => {
    const jpg = row("IMG_1938.JPG", Date.UTC(2011, 4, 28, 14, 53) / 1000, "exif", {
      dir: "/lib/Photos from 2011",
      model: "Canon EOS 500D",
    });
    const tif = row("IMG_1938.tif", Date.UTC(2009, 8, 27, 10, 46) / 1000, "exif", {
      dir: "/lib/Photos from 2019",
      model: "Canon EOS 500D",
    });
    expect(fixFor([jpg, tif], tif)).toMatchObject({ source: "original", local: jpg.t });
  });

  test("another camera's file with the same name is not a twin", () => {
    const other = row("IMG_1938.JPG", Date.UTC(2011, 4, 28) / 1000, "exif", {
      dir: "/lib/Photos from 2011",
      model: "iPhone 4",
    });
    const tif = row("IMG_1938.tif", Date.UTC(2009, 8, 27) / 1000, "exif", {
      dir: "/lib/Photos from 2019",
      model: "Canon EOS 500D",
    });
    expect(fixFor([other, tif], tif)?.source).toBe("folder");
  });

  test("otherwise the folder year wins, keeping a burst in order", () => {
    const shots = [0, 7, 11].map((s, k) =>
      row(`DSC_${1156 + k}.jpg`, Date.UTC(2011, 3, 4, 17, 10) / 1000 + s, "exif", {
        dir: "/lib/Photos from 2020",
        model: "NIKON D3100",
      }),
    );
    // Another contradicted photo in the same folder, years apart, mustn't disturb the burst.
    const collage = row("IMG_0897-COLLAGE.jpg", Date.UTC(2010, 7, 5) / 1000, "exif", { dir: "/lib/Photos from 2020" });
    const fixes = inferDates([...shots, collage], machine);
    const start = Date.UTC(2020, 0, 1, 17, 10) / 1000;
    expect(shots.map((s) => fixes.find((f) => f.id === s.id))).toMatchObject([
      { source: "folder", local: start },
      { source: "folder", local: start + 7 },
      { source: "folder", local: start + 11 },
    ]);
  });

  test("a collage is a new image, never a twin of its first photo", () => {
    const orig = row("IMG_20160422_143639.jpg", Date.UTC(2016, 3, 22) / 1000, "exif", {
      dir: "/lib/Photos from 2016",
      model: "Pixel",
    });
    const collage = row("IMG_20160422_143639-COLLAGE.jpg", Date.UTC(2016, 3, 22) / 1000, "exif", {
      dir: "/lib/Photos from 2018",
      model: "Pixel",
    });
    expect(fixFor([orig, collage], collage)?.source).toBe("folder");
  });

  test("New Year is not a contradiction (Google files by UTC)", () => {
    const p = row("IMG_1.jpg", Date.UTC(2012, 11, 31, 23, 30) / 1000, "exif", { dir: "/lib/Photos from 2013" });
    expect(fixFor([p], p)).toBeUndefined();
  });

  test("a contradicted date never anchors numbered neighbours", () => {
    const wrong = row("IMG_0100.jpg", Date.UTC(2009, 0, 1) / 1000 + 5 * day, "exif", { dir: "/lib/Photos from 2019" });
    const p = undated("IMG_0101.jpg", { dir: "/lib/Photos from 2019" });
    expect(fixFor([wrong, p], p)?.source).toBe("folder");
  });
});
