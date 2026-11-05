/**
 * Non-destructive photo edits, stored as JSON on the photo row. Shared by the browser editor
 * (live preview) and the server (thumbnails, copies, writing into the file), so both read the
 * same geometry and the same tweak values.
 *
 * Geometry, applied in this order to the photo as displayed (EXIF orientation already applied):
 *   1. `quarter` clockwise 90° turns → the "frame", W'×H'
 *   2. `angle` degrees clockwise, about the frame's centre (straightening)
 *   3. `crop`, an axis-aligned rectangle in frame coordinates, normalised to 0..1.
 *      It always lies inside the rotated photo, so no empty corners show.
 * Then the tweaks run on the cropped result.
 */

export const TWEAKS = [
  "hdr",
  "brightness",
  "contrast",
  "highlights",
  "shadows",
  "blackPoint",
  "saturation",
  "warmth",
  "tint",
  "pop",
  "vignette",
] as const;
export type TweakName = (typeof TWEAKS)[number];
export type Tweaks = Record<TweakName, number>;

/** Slider ranges; everything else goes from -100 to 100. */
export const TWEAK_MIN: Partial<Record<TweakName, number>> = { hdr: 0 };

export const ASPECTS = ["free", "16:9", "4:3", "1:1"] as const;
export type Aspect = (typeof ASPECTS)[number];

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Edits {
  v: 1;
  quarter: 0 | 1 | 2 | 3;
  /** Straightening, -45..45 degrees, clockwise. */
  angle: number;
  crop: Rect;
  aspect: Aspect;
  /** Aspect presets are portrait (9:16, 3:4) rather than landscape. */
  portrait: boolean;
  tweaks: Tweaks;
}

export const MAX_ANGLE = 45;
export const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };

export const noTweaks = (): Tweaks => Object.fromEntries(TWEAKS.map((k) => [k, 0])) as Tweaks;

export const identity = (): Edits => ({
  v: 1,
  quarter: 0,
  angle: 0,
  crop: { ...FULL },
  aspect: "free",
  portrait: false,
  tweaks: noTweaks(),
});

const EPS = 1e-4;
const near = (a: number, b: number) => Math.abs(a - b) < EPS;

export const hasTweaks = (t: Tweaks) => TWEAKS.some((k) => t[k] !== 0);

export const hasGeometry = (e: Edits) =>
  e.quarter !== 0 ||
  !near(e.angle, 0) ||
  !near(e.crop.x, 0) ||
  !near(e.crop.y, 0) ||
  !near(e.crop.w, 1) ||
  !near(e.crop.h, 1);

/** True when the edits change nothing (the aspect preset alone isn't an edit). */
export const isIdentity = (e: Edits) => !hasGeometry(e) && !hasTweaks(e.tweaks);

export function sameEdits(a: Edits, b: Edits): boolean {
  if (isIdentity(a) && isIdentity(b)) return true;
  return (
    a.quarter === b.quarter &&
    near(a.angle, b.angle) &&
    near(a.crop.x, b.crop.x) &&
    near(a.crop.y, b.crop.y) &&
    near(a.crop.w, b.crop.w) &&
    near(a.crop.h, b.crop.h) &&
    TWEAKS.every((k) => a.tweaks[k] === b.tweaks[k])
  );
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Parses stored or submitted edits. Null for anything malformed. Values are clamped to
 * their ranges; given the frame's aspect (W'/H'), a crop that doesn't fit the rotation is
 * shrunk until it does.
 */
export function parseEdits(raw: unknown, frameAspect?: number): Edits | null {
  const v = typeof raw === "string" ? safeJson(raw) : raw;
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const quarter = num(o.quarter);
  const angle = num(o.angle);
  const c = o.crop as Record<string, unknown> | undefined;
  const crop = c && { x: num(c.x), y: num(c.y), w: num(c.w), h: num(c.h) };
  if (quarter == null || angle == null || !crop || Object.values(crop).some((x) => x == null)) return null;
  const t = (o.tweaks ?? {}) as Record<string, unknown>;
  const tweaks = noTweaks();
  for (const k of TWEAKS) tweaks[k] = Math.round(clamp(num(t[k]) ?? 0, TWEAK_MIN[k] ?? -100, 100));
  const w = clamp(crop.w!, 0.01, 1);
  const h = clamp(crop.h!, 0.01, 1);
  const e: Edits = {
    v: 1,
    quarter: (((Math.round(quarter) % 4) + 4) % 4) as Edits["quarter"],
    angle: clamp(angle, -MAX_ANGLE, MAX_ANGLE),
    crop: { x: clamp(crop.x!, 0, 1 - w), y: clamp(crop.y!, 0, 1 - h), w, h },
    aspect: ASPECTS.includes(o.aspect as Aspect) ? (o.aspect as Aspect) : "free",
    portrait: o.portrait === true,
    tweaks,
  };
  if (frameAspect) e.crop = fitCrop(e.crop, e.angle, frameAspect);
  return e;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Frame size after the quarter turns. */
export function frameSize(w: number, h: number, quarter: number): [number, number] {
  return quarter % 2 ? [h, w] : [w, h];
}

/** Pixel size of the edited photo, from the size of the photo as displayed. */
export function editedSize(w: number, h: number, e: Edits): [number, number] {
  const [fw, fh] = frameSize(w, h, e.quarter);
  return [Math.max(1, Math.round(e.crop.w * fw)), Math.max(1, Math.round(e.crop.h * fh))];
}

// ---------------------------------------------------------------- crop geometry
// Worked in frame units where the frame is `aspect` wide and 1 tall, so a rotation is a rotation.

function corners(r: Rect, a: number): [number, number][] {
  return [
    [r.x * a, r.y],
    [(r.x + r.w) * a, r.y],
    [r.x * a, r.y + r.h],
    [(r.x + r.w) * a, r.y + r.h],
  ];
}

/** Whether the crop lies inside the photo rotated by `angle` degrees (frame `aspect` = W'/H'). */
export function cropFits(r: Rect, angle: number, aspect: number, slack = 1e-6): boolean {
  const t = (angle * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const hx = aspect / 2 + slack;
  const hy = 0.5 + slack;
  for (const [px, py] of corners(r, aspect)) {
    const dx = px - aspect / 2;
    const dy = py - 0.5;
    // Into the photo's own axes: rotate back by -angle.
    const u = dx * cos + dy * sin;
    const v = -dx * sin + dy * cos;
    if (Math.abs(u) > hx || Math.abs(v) > hy) return false;
  }
  return true;
}

/**
 * The crop, shrunk about its centre (and moved toward the middle if even its centre is
 * outside) until it fits the rotated photo. Keeps its shape.
 */
export function fitCrop(r: Rect, angle: number, aspect: number): Rect {
  if (cropFits(r, angle, aspect)) return r;
  const t = (angle * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  let cx = r.x + r.w / 2;
  let cy = r.y + r.h / 2;
  const inside = (x: number, y: number) => cropFits({ x, y, w: 0, h: 0 }, angle, aspect);
  if (!inside(cx, cy)) {
    // Toward the centre until it's inside.
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 30; i++) {
      const m = (lo + hi) / 2;
      if (inside(0.5 + (cx - 0.5) * m, 0.5 + (cy - 0.5) * m)) lo = m;
      else hi = m;
    }
    cx = 0.5 + (cx - 0.5) * lo;
    cy = 0.5 + (cy - 0.5) * lo;
  }
  // Largest scale s with every corner inside: each corner moves linearly with s, so each
  // axis of each corner gives an upper bound.
  let s = 1;
  const ox = cx * aspect - aspect / 2;
  const oy = cy - 0.5;
  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ] as const) {
    const dx = (sx * r.w * aspect) / 2;
    const dy = (sy * r.h) / 2;
    for (const [a, b, half] of [
      [ox * cos + oy * sin, dx * cos + dy * sin, aspect / 2],
      [-ox * sin + oy * cos, -dx * sin + dy * cos, 0.5],
    ] as const) {
      if (Math.abs(b) < 1e-12) continue;
      const bound = b > 0 ? (half - a) / b : (-half - a) / b;
      s = Math.min(s, bound);
    }
  }
  s = Math.max(0.01, s * (1 - 1e-6));
  const w = r.w * s;
  const h = r.h * s;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/** Width/height of an aspect preset, in pixels; null for free. */
export function aspectRatio(a: Aspect, portrait: boolean): number | null {
  if (a === "free") return null;
  const [w, h] = a.split(":").map(Number) as [number, number];
  return portrait ? h / w : w / h;
}

/** The largest crop with pixel aspect `ratio` (w/h), centred in the frame, that fits the rotation. */
export function presetCrop(ratio: number, angle: number, frameAspect: number): Rect {
  // In normalised units, w/h = ratio / frameAspect.
  const k = ratio / frameAspect;
  const r = k >= 1 ? { w: 1, h: 1 / k } : { w: k, h: 1 };
  return fitCrop({ x: (1 - r.w) / 2, y: (1 - r.h) / 2, ...r }, angle, frameAspect);
}

/** Turns the edits a quarter clockwise (dir 1) or anticlockwise (-1), carrying the crop along. */
export function turn(e: Edits, dir: 1 | -1): Edits {
  const c = e.crop;
  const crop = dir === 1 ? { x: 1 - c.y - c.h, y: c.x, w: c.h, h: c.w } : { x: c.y, y: 1 - c.x - c.w, w: c.h, h: c.w };
  return {
    ...e,
    quarter: ((((e.quarter + dir) % 4) + 4) % 4) as Edits["quarter"],
    crop,
    portrait: e.aspect === "free" ? e.portrait : !e.portrait,
  };
}

export const serialize = (e: Edits) => JSON.stringify(e);
