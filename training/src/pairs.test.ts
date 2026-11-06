import { describe, expect, test } from "bun:test";
import { findPairs, parseEdited } from "./pairs";

const f = (path: string, size = 100) => ({ path, size });

describe("edited names", () => {
  test("suffixes, counters and cut names", () => {
    expect(parseEdited("IMG_1234-edited")).toEqual({ base: "IMG_1234", counter: "", cut: false });
    expect(parseEdited("IMG_1234-EDITED(2)")).toEqual({ base: "IMG_1234", counter: "(2)", cut: false });
    expect(parseEdited("IMG_1234-editado")).toEqual({ base: "IMG_1234", counter: "", cut: false });
    expect(parseEdited("PXL_20210815_123456789.PORTRAIT-edi")).toEqual({
      base: "PXL_20210815_123456789.PORTRAIT",
      counter: "",
      cut: true,
    });
    expect(parseEdited("IMG_1234")).toBeNull();
    expect(parseEdited("my-trip")).toBeNull();
  });
});

describe("pairs", () => {
  test("matches originals in the same folder, any format, keeping counters apart", () => {
    const { pairs, stats } = findPairs([
      f("/t/2017/IMG_1.JPG"),
      f("/t/2017/IMG_1-edited.JPG"),
      f("/t/2017/IMG_1(1).JPG"),
      f("/t/2017/IMG_1-edited(1).JPG", 200),
      f("/t/2018/IMG_2.HEIC"),
      f("/t/2018/IMG_2-edited.jpg"),
      f("/t/2018/IMG_3-edited.jpg"),
      f("/t/2018/notes.json"),
    ]);
    expect(pairs).toEqual([
      { edited: "/t/2017/IMG_1-edited(1).JPG", original: "/t/2017/IMG_1(1).JPG" },
      { edited: "/t/2017/IMG_1-edited.JPG", original: "/t/2017/IMG_1.JPG" },
      { edited: "/t/2018/IMG_2-edited.jpg", original: "/t/2018/IMG_2.HEIC" },
      { edited: "/t/2018/IMG_3-edited.jpg", original: null },
    ]);
    expect(stats).toEqual({ images: 7, edited: 4, withOriginal: 3, duplicates: 0 });
  });

  test("prefers the edit's own format, drops album copies", () => {
    const { pairs, stats } = findPairs([
      f("/t/2019/IMG_5.HEIC"),
      f("/t/2019/IMG_5.JPG"),
      f("/t/2019/IMG_5-edited.JPG", 300),
      f("/t/Album/IMG_5.JPG"),
      f("/t/Album/IMG_5-edited.JPG", 300),
    ]);
    expect(pairs).toEqual([{ edited: "/t/2019/IMG_5-edited.JPG", original: "/t/2019/IMG_5.JPG" }]);
    expect(stats.duplicates).toBe(1);
  });

  test("a cut suffix counts only when its original exists", () => {
    const { pairs } = findPairs([
      f("/t/a/LONG_NAME_0001.jpg"),
      f("/t/a/LONG_NAME_0001-edi.jpg"),
      f("/t/a/beach-ed.jpg"),
    ]);
    expect(pairs).toEqual([{ edited: "/t/a/LONG_NAME_0001-edi.jpg", original: "/t/a/LONG_NAME_0001.jpg" }]);
  });
});

describe("takeout listings", () => {
  test("bsdtar's verbose listing, names with spaces and accents", async () => {
    const { parseListing } = await import("./takeout");
    const text = [
      "drwxr-xr-x  0 0      0           0 Nov  5 16:51 Takeout/Google Photos/",
      "-rw-rw-r--  0 0      0     8208935 Nov  5 16:51 Takeout/Google Photos/Photos from 2018/IMG 1-edited.jpg",
      "-rw-rw-r--  0 0      0         862 Nov  5  2025 Takeout/Google Photos/Myra, Demre, Türkiye/IMG_2.jpg",
    ].join("\n");
    expect(parseListing(text, "a.zip")).toEqual([
      { zip: "a.zip", size: 8208935, path: "Takeout/Google Photos/Photos from 2018/IMG 1-edited.jpg" },
      { zip: "a.zip", size: 862, path: "Takeout/Google Photos/Myra, Demre, Türkiye/IMG_2.jpg" },
    ]);
  });
});
