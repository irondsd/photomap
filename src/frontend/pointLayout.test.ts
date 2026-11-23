import { expect, test } from "bun:test";
import { POINT_SPACING, PointGrid, spreadPhotoPoints } from "./pointLayout";

test("packs a center and six nearby photos into the first hexagonal ring", () => {
  const points = Array.from({ length: 7 }, (_, index) => ({ x: 200 + index / 2, y: 100, index }));
  const placed = spreadPhotoPoints(points);
  expect(placed[0]).toEqual(points[0]!);
  expect(placed.map((point) => point.index)).toEqual(points.map((point) => point.index));
  for (const { x, y } of placed.slice(1)) {
    expect(Math.hypot(x - 200, y - 100)).toBeCloseTo(POINT_SPACING);
  }
  expect(new Set(placed.map(({ x, y }) => `${x},${y}`)).size).toBe(7);
});

test("gives larger stacks distinct pickable positions and leaves an isolated point in place", () => {
  const isolated = { x: 100, y: 100, index: 50 };
  const points = Array.from({ length: 50 }, (_, index) => ({ x: 0, y: 0, index })).concat(isolated);
  const grid = new PointGrid<(typeof points)[number]>();
  const placed = spreadPhotoPoints(points);
  for (const point of placed) {
    expect(grid.nearest(point.x, point.y, POINT_SPACING - 0.01)).toBeNull();
    grid.add(point);
  }
  expect(grid.nearest(isolated.x, isolated.y, 7)).toEqual(isolated);
});
