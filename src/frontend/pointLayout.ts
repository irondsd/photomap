interface Position {
  x: number;
  y: number;
}

export interface PhotoPoint extends Position {
  index: number;
}

export const POINT_SPACING = 14;

/** Screen-space lookup for collision detection and picking a dot. */
export class PointGrid<T extends Position> {
  private cells = new Map<string, T[]>();

  add(point: T) {
    const key = `${Math.floor(point.x / POINT_SPACING)},${Math.floor(point.y / POINT_SPACING)}`;
    const cell = this.cells.get(key);
    if (cell) cell.push(point);
    else this.cells.set(key, [point]);
  }

  nearest(x: number, y: number, radius: number): T | null {
    let closest: T | null = null;
    let distance = radius * radius;
    for (let col = Math.floor((x - radius) / POINT_SPACING); col <= Math.floor((x + radius) / POINT_SPACING); col++) {
      for (let row = Math.floor((y - radius) / POINT_SPACING); row <= Math.floor((y + radius) / POINT_SPACING); row++) {
        for (const point of this.cells.get(`${col},${row}`) ?? []) {
          const d = (point.x - x) ** 2 + (point.y - y) ** 2;
          if (d < distance) {
            closest = point;
            distance = d;
          }
        }
      }
    }
    return closest;
  }
}

function* hexSlots(): Generator<Position, never> {
  yield { x: 0, y: 0 };
  const directions = [
    [-1, 1],
    [-1, 0],
    [0, -1],
    [1, -1],
    [1, 0],
    [0, 1],
  ] as const;
  for (let ring = 1; ; ring++) {
    let q = ring;
    let r = 0;
    for (const [dq, dr] of directions) {
      for (let step = 0; step < ring; step++) {
        yield { x: (q + r / 2) * POINT_SPACING, y: (r * POINT_SPACING * Math.sqrt(3)) / 2 };
        q += dq;
        r += dr;
      }
    }
  }
}

/** Leave isolated photos at their real position and fan collisions out from a shared center. */
export function spreadPhotoPoints(points: PhotoPoint[]): PhotoPoint[] {
  const groups = new PointGrid<Position & { slots: ReturnType<typeof hexSlots> }>();
  const occupied = new PointGrid<PhotoPoint>();
  const placed: PhotoPoint[] = [];
  for (const point of points) {
    let group = groups.nearest(point.x, point.y, POINT_SPACING);
    if (!group) {
      group = { x: point.x, y: point.y, slots: hexSlots() };
      groups.add(group);
    }
    while (true) {
      const offset = group.slots.next().value;
      const x = group.x + offset.x;
      const y = group.y + offset.y;
      if (occupied.nearest(x, y, POINT_SPACING - 0.01)) continue;
      const slot = { x, y, index: point.index };
      occupied.add(slot);
      placed.push(slot);
      break;
    }
  }
  return placed;
}
