import { test, expect } from "bun:test";
import { joinSplitPaths } from "./roots";

const existing = new Set(["/p/My Photos/CameraRoll", "/p/Other", "/p/A B C"]);
const exists = (p: string) => existing.has(p);

test("rejoins a path split on spaces", () => {
  expect(joinSplitPaths(["/p/My", "Photos/CameraRoll"], exists)).toEqual(["/p/My Photos/CameraRoll"]);
});

test("keeps separate valid paths separate", () => {
  expect(joinSplitPaths(["/p/Other", "/p/My", "Photos/CameraRoll"], exists)).toEqual([
    "/p/Other",
    "/p/My Photos/CameraRoll",
  ]);
});

test("multiple spaces", () => {
  expect(joinSplitPaths(["/p/A", "B", "C"], exists)).toEqual(["/p/A B C"]);
});

test("leaves unknown paths alone so they error clearly", () => {
  expect(joinSplitPaths(["/nope", "x"], exists)).toEqual(["/nope", "x"]);
});
