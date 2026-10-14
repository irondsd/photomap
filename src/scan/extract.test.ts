import { test, expect } from "bun:test";
import { uuidV1Seconds, parseIso6709 } from "./extract";

test("Photoshop instance IDs decode to their save time", () => {
  // From a real export: saved 6 Aug 2012, 09:53:08 UTC.
  expect(new Date(uuidV1Seconds("xmp.iid:8683A3D3DFAC11E1922ED22E09E88736")! * 1000).toISOString()).toBe("2012-08-06T09:53:08.000Z");
  expect(uuidV1Seconds("uuid:8683a3d3-dfac-11e1-922e-d22e09e88736")).toBe(uuidV1Seconds("xmp.iid:8683A3D3DFAC11E1922ED22E09E88736"));
});

test("random (v4) IDs and Adobe's placeholder ID say nothing", () => {
  expect(uuidV1Seconds("xmp.did:2f9e6c3a5b1d4e8f9a0b1c2d3e4f5a6b")).toBeNull();
  expect(uuidV1Seconds("uuid:faf5bdd5-ba3d-11da-ad31-d33d75182f1b")).toBeNull();
  expect(uuidV1Seconds("adobe:docid:photoshop:not-a-uuid")).toBeNull();
});

test("ISO 6709 locations from phone videos", () => {
  expect(parseIso6709("+37.7749-122.4194+010.000/")).toEqual({ lat: 37.7749, lon: -122.4194, alt: 10 });
  expect(parseIso6709("+00.0000+000.0000/")).toBeNull();
});
