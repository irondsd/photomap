import { describe, expect, test } from "bun:test";
import { parsePairing } from "./pairing";

const code = (fields: Record<string, unknown>) =>
  JSON.stringify({ v: 1, url: "http://192.168.1.20:4747", token: "t0k3n", name: "Mac", ...fields });

describe("parsePairing", () => {
  test("reads a pairing code", () => {
    expect(parsePairing(code({}))).toEqual({ url: "http://192.168.1.20:4747", token: "t0k3n", name: "Mac" });
  });

  test("drops a trailing slash so paths can be appended", () => {
    expect(parsePairing(code({ url: "http://192.168.1.20:4747/" })).url).toBe("http://192.168.1.20:4747");
  });

  test("falls back to the host when the code has no name", () => {
    expect(parsePairing(code({ name: "" })).name).toBe("192.168.1.20:4747");
  });

  test("rejects codes that aren't Photomap's", () => {
    expect(() => parsePairing("https://example.com")).toThrow("isn't a Photomap pairing code");
    expect(() => parsePairing("42")).toThrow("isn't a Photomap pairing code");
    expect(() => parsePairing(code({ token: "" }))).toThrow("isn't a Photomap pairing code");
  });

  test("rejects other protocol versions", () => {
    expect(() => parsePairing(code({ v: 2 }))).toThrow("different version");
  });

  test("rejects addresses the phone can't fetch", () => {
    expect(() => parsePairing(code({ url: "not a url" }))).toThrow("invalid address");
    expect(() => parsePairing(code({ url: "ftp://192.168.1.20" }))).toThrow("invalid address");
  });
});
