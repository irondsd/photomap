import { expect, test } from "bun:test";
import { formatBytes, plural } from "./format";

test("formatBytes", () => {
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(1536)).toBe("1.5 KB");
  expect(formatBytes(42 * 1024 * 1024)).toBe("42 MB");
  expect(formatBytes(3.2 * 1024 ** 3)).toBe("3.2 GB");
});

test("plural", () => {
  expect(plural(1, "file")).toBe("1 file");
  expect(plural(0, "file")).toBe("0 files");
});
