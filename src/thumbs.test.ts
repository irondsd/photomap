import { expect, test } from "bun:test";
import { join } from "node:path";
import sharp from "sharp";
import { DATA_DIR } from "./config";
import { getThumb } from "./thumbs";

test("a JPEG exported with a DNG extension can generate a thumbnail without a RAW decoder", async () => {
  const path = join(DATA_DIR, "exported.dng");
  await sharp({ create: { width: 64, height: 96, channels: 3, background: "orange" } })
    .jpeg()
    .toFile(path);
  const thumb = await getThumb({ id: 1, path, mtime: 1, kind: "raw", duration: null }, "l");
  expect(thumb).not.toBeNull();
  const meta = await sharp(thumb!).metadata();
  expect(meta.format).toBe("jpeg");
  expect([meta.width, meta.height]).toEqual([64, 96]);
});
