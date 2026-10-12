import { test, expect } from "bun:test";
import { parseCoords } from "./coords";

test.each([
  ["48.858370, 2.294481", { lat: 48.85837, lon: 2.294481 }],
  ["  48.858370 2.294481 ", { lat: 48.85837, lon: 2.294481 }],
  ["-33.856784,151.215297", { lat: -33.856784, lon: 151.215297 }],
  ["https://www.google.com/maps/@48.858370,2.294481,15z", { lat: 48.85837, lon: 2.294481 }],
  ["https://www.google.com/maps/place/Eiffel+Tower/@48.85,2.29,14z/data=!3m1", { lat: 48.85, lon: 2.29 }],
  ["https://www.openstreetmap.org/#map=15/48.8584/2.2945", { lat: 48.8584, lon: 2.2945 }],
])("%s", (input, expected) => {
  expect(parseCoords(input)).toEqual(expected);
});

test.each(["", "Eiffel Tower", "91, 10", "41.1, 181", "41.1"])("rejects %p", (input) => {
  expect(parseCoords(input)).toBeNull();
});
