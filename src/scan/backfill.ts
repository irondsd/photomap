/**
 * Infers locations for photos without GPS from the photos taken around them.
 * Only real fixes (EXIF/video/manual) are used as evidence, so inferences never chain.
 */

export interface BackfillPhoto {
  id: number;
  /** Wall-clock seconds (see datetime.ts). */
  t: number;
  /** Minutes east of UTC, if known. */
  offset: number | null;
  lat: number | null;
  lon: number | null;
}

export type Rule = "burst" | "stay" | "home" | "nearby";
export type Confidence = "high" | "medium" | "low";

export interface Proposal {
  id: number;
  lat: number;
  lon: number;
  rule: Rule;
  confidence: Confidence;
  /** Ids of the geotagged photos the location came from. */
  from: number[];
  /** Minutes to the farther of the photos used. */
  gapMin: number;
}

export interface Skipped {
  id: number;
  reason: "no-neighbours" | "neighbours-far-in-time" | "moving" | "undated";
  gapMin: number;
  /** Metres between the previous and next geotagged photos, when both exist. */
  spreadM: number | null;
}

export interface Home {
  lat: number;
  lon: number;
  days: number;
  first: number;
  last: number;
}

export const BURST_MIN = 15;
const BURST_SURE_MIN = 5;
const MOVING_MAX_KMH = 150;
export const STAY_M = 300;
const STAY_MAX_H = 24;
const STAY_SURE_H = 6;
const HOME_MAX_DAYS = 7;
const HOME_MIN_DAYS = 20;
const HOME_MERGE_M = 300;
const NEARBY_MIN = 60;
const NEARBY_M = 5000;

export function distanceM(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const r = Math.PI / 180;
  const x =
    Math.sin(((bLat - aLat) * r) / 2) ** 2 +
    Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(((bLon - aLon) * r) / 2) ** 2;
  return 2 * 6371e3 * Math.asin(Math.sqrt(x));
}

interface Fix {
  id: number;
  u: number;
  t: number;
  lat: number;
  lon: number;
}

/**
 * Places photographed on many distinct days: homes (or offices), each with the period
 * it was in use. Nearby grid cells are merged so one address doesn't split in two.
 */
export function detectHomes(fixes: { t: number; lat: number; lon: number }[]): Home[] {
  const cells = new Map<
    string,
    { days: Set<number>; n: number; lat: number; lon: number; first: number; last: number }
  >();
  for (const f of fixes) {
    // ~150 m cells
    const key = `${Math.round(f.lat * 700)}:${Math.round(f.lon * 700 * Math.cos((f.lat * Math.PI) / 180))}`;
    let c = cells.get(key);
    if (!c) cells.set(key, (c = { days: new Set(), n: 0, lat: 0, lon: 0, first: f.t, last: f.t }));
    c.days.add(Math.floor(f.t / 86400));
    c.n++;
    c.lat += f.lat;
    c.lon += f.lon;
    c.first = Math.min(c.first, f.t);
    c.last = Math.max(c.last, f.t);
  }
  const sorted = [...cells.values()]
    .map((c) => ({ ...c, lat: c.lat / c.n, lon: c.lon / c.n }))
    .sort((a, b) => b.days.size - a.days.size);
  const homes: (Home & { daySet: Set<number> })[] = [];
  for (const c of sorted) {
    const into = homes.find((h) => distanceM(h.lat, h.lon, c.lat, c.lon) <= HOME_MERGE_M);
    if (into) {
      for (const d of c.days) into.daySet.add(d);
      into.first = Math.min(into.first, c.first);
      into.last = Math.max(into.last, c.last);
    } else {
      homes.push({ lat: c.lat, lon: c.lon, days: 0, first: c.first, last: c.last, daySet: new Set(c.days) });
    }
  }
  return homes.map(({ daySet, ...h }) => ({ ...h, days: daySet.size })).filter((h) => h.days >= HOME_MIN_DAYS);
}

export function infer(photos: BackfillPhoto[]): { proposals: Proposal[]; skipped: Skipped[]; homes: Home[] } {
  // Real instants. Photos without an offset borrow the nearest known one (same trip, same zone).
  const withOffset = photos.filter((p) => p.offset != null).sort((a, b) => a.t - b.t);
  const nearestOffset = (t: number): number => {
    let lo = 0;
    let hi = withOffset.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (withOffset[mid]!.t < t) lo = mid + 1;
      else hi = mid;
    }
    const a = withOffset[lo - 1];
    const b = withOffset[lo];
    const best = !a ? b : !b ? a : t - a.t <= b.t - t ? a : b;
    return best?.offset ?? 0;
  };
  const utc = (p: BackfillPhoto) => p.t - (p.offset ?? nearestOffset(p.t)) * 60;

  const fixes: Fix[] = photos
    // A location without a trustworthy time can't place anything else.
    .filter(
      (p): p is BackfillPhoto & { lat: number; lon: number } => p.lat != null && p.lon != null && Number.isFinite(p.t),
    )
    .map((p) => ({ id: p.id, u: utc(p), t: p.t, lat: p.lat, lon: p.lon }))
    .sort((a, b) => a.u - b.u);
  const homes = detectHomes(fixes);
  const homeAt = (lat: number, lon: number, t: number) =>
    homes.some(
      (h) => distanceM(h.lat, h.lon, lat, lon) <= STAY_M && t >= h.first - 30 * 86400 && t <= h.last + 30 * 86400,
    );

  const proposals: Proposal[] = [];
  const skipped: Skipped[] = [];

  for (const p of photos) {
    if (p.lat != null) continue;
    if (!Number.isFinite(p.t)) {
      skipped.push({ id: p.id, reason: "undated", gapMin: Infinity, spreadM: null });
      continue;
    }
    const u = utc(p);
    // Neighbouring fixes in time.
    let lo = 0;
    let hi = fixes.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (fixes[mid]!.u <= u) lo = mid + 1;
      else hi = mid;
    }
    const prev = fixes[lo - 1];
    const next = fixes[lo];
    const gp = prev ? (u - prev.u) / 60 : Infinity;
    const gn = next ? (next.u - u) / 60 : Infinity;
    const spread = prev && next ? distanceM(prev.lat, prev.lon, next.lat, next.lon) : null;

    if (!prev && !next) {
      skipped.push({ id: p.id, reason: "no-neighbours", gapMin: Infinity, spreadM: null });
      continue;
    }

    // 1. Burst: a fix within minutes.
    if (Math.min(gp, gn) <= BURST_MIN) {
      if (prev && next && gp <= BURST_MIN && gn <= BURST_MIN) {
        const hours = (next.u - prev.u) / 3600;
        const kmh = hours > 0 ? spread! / 1000 / hours : 0;
        if (kmh <= MOVING_MAX_KMH) {
          // Interpolate along the way between the two fixes.
          const k = hours > 0 ? (u - prev.u) / (next.u - prev.u) : 0.5;
          proposals.push({
            id: p.id,
            lat: prev.lat + (next.lat - prev.lat) * k,
            lon: prev.lon + (next.lon - prev.lon) * k,
            rule: "burst",
            confidence: Math.max(gp, gn) <= BURST_SURE_MIN || spread! <= STAY_M ? "high" : "medium",
            from: [prev.id, next.id],
            gapMin: Math.max(gp, gn),
          });
          continue;
        }
        // Too fast to be a real path (a flight?): fall through and use the nearer one.
      }
      const near = gp <= gn ? prev! : next!;
      const gap = Math.min(gp, gn);
      proposals.push({
        id: p.id,
        lat: near.lat,
        lon: near.lon,
        rule: "burst",
        confidence: gap <= BURST_SURE_MIN ? "high" : "medium",
        from: [near.id],
        gapMin: gap,
      });
      continue;
    }

    // 2./3. Same place before and after.
    if (prev && next && spread! <= STAY_M) {
      const spanH = (next.u - prev.u) / 3600;
      const lat = (prev.lat + next.lat) / 2;
      const lon = (prev.lon + next.lon) / 2;
      if (spanH <= STAY_MAX_H) {
        // Over longer spans, "same spot before and after" often means you went out and came
        // back (hold-out test: under a third within 1 km), so those are only a guess.
        proposals.push({
          id: p.id,
          lat,
          lon,
          rule: "stay",
          confidence: spanH <= STAY_SURE_H ? "high" : "low",
          from: [prev.id, next.id],
          gapMin: Math.max(gp, gn),
        });
        continue;
      }
      if (spanH <= HOME_MAX_DAYS * 24 && homeAt(lat, lon, p.t)) {
        proposals.push({
          id: p.id,
          lat,
          lon,
          rule: "home",
          confidence: "low",
          from: [prev.id, next.id],
          gapMin: Math.max(gp, gn),
        });
        continue;
      }
      skipped.push({ id: p.id, reason: "neighbours-far-in-time", gapMin: Math.max(gp, gn), spreadM: spread });
      continue;
    }

    // 4. Moving around one area: a fix within the hour, before and after no more than a few km apart.
    if (Math.min(gp, gn) <= NEARBY_MIN && (spread == null || spread <= NEARBY_M)) {
      const near = gp <= gn ? prev! : next!;
      proposals.push({
        id: p.id,
        lat: near.lat,
        lon: near.lon,
        rule: "nearby",
        confidence: "low",
        from: [near.id],
        gapMin: Math.min(gp, gn),
      });
      continue;
    }

    skipped.push({
      id: p.id,
      reason: spread != null && spread > STAY_M ? "moving" : "neighbours-far-in-time",
      gapMin: Math.min(gp, gn),
      spreadM: spread,
    });
  }

  return { proposals, skipped, homes };
}
