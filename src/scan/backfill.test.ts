import { test, expect, describe } from "bun:test";
import { infer, detectHomes, type BackfillPhoto } from "./backfill";

const T0 = Date.UTC(2024, 5, 1, 12) / 1000;
const min = 60;
const hour = 3600;
const day = 86400;
let nextId = 1;
const at = (dt: number, lat: number | null = null, lon: number | null = null, offset: number | null = 0): BackfillPhoto => ({
  id: nextId++,
  t: T0 + dt,
  offset,
  lat,
  lon,
});

// ~0.001° latitude ≈ 111 m
const PARIS = { lat: 48.8584, lon: 2.2945 };

describe("burst", () => {
  test("copies a fix taken a minute earlier", () => {
    const a = at(0, PARIS.lat, PARIS.lon);
    const p = at(1 * min);
    const { proposals } = infer([a, p]);
    expect(proposals).toEqual([{ id: p.id, lat: PARIS.lat, lon: PARIS.lon, rule: "burst", confidence: "high", from: [a.id], gapMin: 1 }]);
  });

  test("interpolates between fixes on both sides", () => {
    const a = at(0, 0.5, 10);
    const p = at(5 * min);
    const b = at(10 * min, 0.51, 10);
    const [r] = infer([a, p, b]).proposals;
    expect(r!.lat).toBeCloseTo(0.505, 6);
    expect(r!.from).toEqual([a.id, b.id]);
  });

  test("a fix 12 minutes away is only medium confidence", () => {
    const a = at(0, PARIS.lat, PARIS.lon);
    const p = at(12 * min);
    expect(infer([a, p]).proposals[0]!.confidence).toBe("medium");
  });

  test("impossible speed (a flight) falls back to the nearer fix", () => {
    const a = at(0, 48.8566, 2.3522); // Paris
    const p = at(2 * min);
    const b = at(14 * min, -33.8688, 151.2093); // Sydney
    const [r] = infer([a, p, b]).proposals;
    expect(r!.from).toEqual([a.id]);
  });

  test("uses real instants, not wall clocks across time zones", () => {
    // Fix at 12:00 UTC+3; untagged at 09:01 wall clock UTC+0 → one minute later in real time.
    const a = at(3 * hour, PARIS.lat, PARIS.lon, 180);
    const p = at(1 * min, null, null, 0);
    expect(infer([a, p]).proposals[0]!.gapMin).toBe(1);
  });
});

describe("untrustworthy times", () => {
  test("a GPS photo without a usable date is never evidence", () => {
    const bogus = { id: nextId++, t: NaN, offset: null, lat: PARIS.lat, lon: PARIS.lon };
    const p = at(0);
    const r = infer([bogus, p]);
    expect(r.proposals).toEqual([]);
    expect(r.skipped[0]).toMatchObject({ id: p.id, reason: "no-neighbours" });
  });
});

describe("stay", () => {
  test("same place before and after within a day", () => {
    const a = at(0, PARIS.lat, PARIS.lon);
    const p = at(3 * hour);
    const b = at(5 * hour, PARIS.lat + 0.001, PARIS.lon);
    const [r] = infer([a, p, b]).proposals;
    expect(r).toMatchObject({ rule: "stay", confidence: "high" });
    expect(r!.lat).toBeCloseTo(PARIS.lat + 0.0005, 6);
  });

  test("a long stay (evening to morning) is only a low-confidence guess", () => {
    const a = at(0, PARIS.lat, PARIS.lon);
    const p = at(8 * hour);
    const b = at(14 * hour, PARIS.lat, PARIS.lon);
    expect(infer([a, p, b]).proposals[0]).toMatchObject({ rule: "stay", confidence: "low" });
  });

  test("different places before and after are skipped as moving", () => {
    const a = at(0, PARIS.lat, PARIS.lon);
    const p = at(3 * hour);
    const b = at(5 * hour, PARIS.lat + 0.05, PARIS.lon);
    const r = infer([a, p, b]);
    expect(r.proposals).toEqual([]);
    expect(r.skipped[0]!.reason).toBe("moving");
  });
});

describe("nearby", () => {
  test("a fix 40 minutes away in the same area is a low-confidence guess", () => {
    const a = at(0, PARIS.lat, PARIS.lon);
    const p = at(40 * min);
    const b = at(3 * hour, PARIS.lat + 0.02, PARIS.lon); // ~2 km away
    expect(infer([a, p, b]).proposals[0]).toMatchObject({ rule: "nearby", confidence: "low", from: [a.id] });
  });

  test("not when the next place is in another city", () => {
    const a = at(0, PARIS.lat, PARIS.lon);
    const p = at(40 * min);
    const b = at(3 * hour, PARIS.lat + 0.5, PARIS.lon); // ~55 km
    expect(infer([a, p, b]).proposals).toEqual([]);
  });
});

describe("home", () => {
  const homeHistory = () => Array.from({ length: 30 }, (_, i) => at(-60 * day + i * 2 * day, PARIS.lat, PARIS.lon));

  test("detects a place photographed on many days", () => {
    const homes = detectHomes(homeHistory().map((p) => ({ t: p.t, lat: p.lat!, lon: p.lon! })));
    expect(homes).toHaveLength(1);
    expect(homes[0]!.days).toBe(30);
  });

  test("multi-day gap at home → low-confidence home", () => {
    const a = at(0, PARIS.lat, PARIS.lon);
    const p = at(2 * day);
    const b = at(4 * day, PARIS.lat, PARIS.lon);
    const r = infer([...homeHistory(), a, p, b]).proposals.find((x) => x.id === p.id);
    expect(r).toMatchObject({ rule: "home", confidence: "low" });
  });

  test("the same gap somewhere that isn't home is left alone", () => {
    const a = at(0, 10, 10);
    const p = at(2 * day);
    const b = at(4 * day, 10, 10);
    const r = infer([...homeHistory(), a, p, b]);
    expect(r.proposals.find((x) => x.id === p.id)).toBeUndefined();
    expect(r.skipped.find((x) => x.id === p.id)?.reason).toBe("neighbours-far-in-time");
  });
});
