import { expect, test } from "bun:test";
import { toPlace } from "./places";

test("names a place and lists where it is, without repeats", () => {
  const p = toPlace({
    geometry: { coordinates: [2.2945, 48.8584] },
    properties: {
      name: "Eiffel Tower",
      street: "Avenue Anatole France",
      housenumber: "5",
      city: "Paris",
      state: "Île-de-France",
      country: "France",
      extent: [2.29, 48.86, 2.3, 48.85],
    },
  });
  expect(p).toEqual({
    at: { lat: 48.8584, lon: 2.2945 },
    name: "Eiffel Tower",
    context: "Avenue Anatole France 5, Paris, Île-de-France, France",
    bounds: [2.29, 48.85, 2.3, 48.86],
  });
  expect(
    toPlace({
      geometry: { coordinates: [2.35, 48.85] },
      properties: { name: "Paris", city: "Paris", country: "France" },
    })?.context,
  ).toBe("France");
});

test("falls back to the street address, and skips features with no name", () => {
  expect(
    toPlace({ geometry: { coordinates: [0, 0] }, properties: { street: "Main St", housenumber: "1", city: "X" } })
      ?.name,
  ).toBe("Main St 1");
  expect(toPlace({ geometry: { coordinates: [0, 0] }, properties: { city: "X" } })).toBeNull();
});
