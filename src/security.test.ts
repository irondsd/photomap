import { expect, test } from "bun:test";
import { forbidden } from "./security";

const allowed = new Set(["photomap.local"]);
const request = (host: string, method = "GET", origin?: string) =>
  new Request("http://localhost/api/stats", {
    method,
    headers: { host, ...(origin ? { origin } : {}) },
  });

test("local addresses still work, while custom domains require explicit configuration", () => {
  for (const host of ["localhost:4747", "127.0.0.1:4747", "[::1]:4747", "photomap.localhost:4747"]) {
    expect(forbidden(request(host), new Set())).toBe(false);
  }
  expect(forbidden(request("photomap.local"), new Set())).toBe(true);
  expect(forbidden(request("PHOTOMAP.LOCAL:4747"), allowed)).toBe(false);
  for (const host of ["evil.local", "photomap.local.evil.com", "sub.photomap.local", ""]) {
    expect(forbidden(request(host), allowed)).toBe(true);
  }
});

test("writes work through HTTP and HTTPS with a matching host and port", () => {
  for (const origin of ["http://photomap.local", "https://photomap.local"]) {
    expect(forbidden(request("photomap.local", "POST", origin), allowed)).toBe(false);
  }
  expect(forbidden(request("localhost:4747", "DELETE", "http://localhost:4747"), allowed)).toBe(false);
  expect(forbidden(request("photomap.local", "POST"), allowed)).toBe(false);
});

test("foreign origins and mismatched ports cannot write to an allowed domain", () => {
  for (const origin of ["https://evil.com", "https://evil.local", "https://photomap.local:4747", "null"]) {
    expect(forbidden(request("photomap.local", "POST", origin), allowed)).toBe(true);
  }
  expect(forbidden(request("evil.com", "POST", "https://evil.com"), allowed)).toBe(true);
});
