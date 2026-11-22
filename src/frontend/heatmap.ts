import type { FeatureCollection, MultiPoint } from "geojson";
import type { HeatmapLayerSpecification, Map as MlMap } from "maplibre-gl";
import { passesPhotoFilter, type Points, type Range } from "./data";

const HEATMAP = "photomap-heatmap";
const SPREADS = [
  { radius: 18, weight: 0.55 },
  { radius: 42, weight: 0.3 },
  { radius: 90, weight: 0.15 },
];

type HeatmapData = FeatureCollection<MultiPoint, { radius: number; weight: number }>;

export function heatmapData(
  points: Points,
  range: Range | null,
  kinds: number,
  membership: Uint8Array | null,
): HeatmapData {
  const locations = new Map<string, { coordinates: [number, number]; count: number }>();
  for (let i = 0; i < points.n; i++) {
    if ((membership && !membership[i]) || !passesPhotoFilter(points, i, range, kinds)) continue;
    const lat = points.lat[i]!;
    const lon = points.lon[i]!;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const key = `${lon},${lat}`;
    const location = locations.get(key);
    if (location) location.count++;
    else locations.set(key, { coordinates: [lon, lat], count: 1 });
  }

  // A MultiPoint shares one weight across locations with the same photo count.
  // All three radii feed one heatmap layer, so their densities add before coloring.
  const byCount = new Map<number, MultiPoint>();
  for (const { coordinates, count } of locations.values()) {
    let geometry = byCount.get(count);
    if (!geometry) byCount.set(count, (geometry = { type: "MultiPoint", coordinates: [] }));
    geometry.coordinates.push(coordinates);
  }
  const features: HeatmapData["features"] = [];
  for (const [count, geometry] of byCount) {
    for (const { radius, weight } of SPREADS) {
      features.push({ type: "Feature", geometry, properties: { radius, weight: count * weight } });
    }
  }
  return { type: "FeatureCollection", features };
}

const radius = ["number", ["get", "radius"]] as const;
const layer: HeatmapLayerSpecification = {
  id: HEATMAP,
  source: HEATMAP,
  type: "heatmap",
  paint: {
    "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 0, ["*", 0.24, [...radius]], 3, [...radius]],
    "heatmap-weight": ["get", "weight"],
    "heatmap-intensity": [
      "interpolate",
      ["exponential", 1.2],
      ["zoom"],
      0,
      0.003,
      3,
      0.009,
      7,
      0.035,
      12,
      0.1,
      17,
      0.13,
    ],
    "heatmap-color": [
      "interpolate",
      ["linear"],
      ["heatmap-density"],
      0,
      "rgba(164,129,208,0)",
      0.006,
      "rgba(164,129,208,0.08)",
      0.03,
      "rgba(164,129,208,0.27)",
      0.14,
      "rgba(164,57,151,0.5)",
      0.44,
      "rgba(230,74,72,0.68)",
      1,
      "rgba(255,187,54,0.81)",
    ],
  },
};

/** Install beneath map labels and restore after a basemap theme change. */
export function showHeatmap(map: MlMap, data: HeatmapData): () => void {
  if (!data.features.length) return () => {};
  const add = () => {
    if (map.getSource(HEATMAP)) return;
    const before = map.getStyle()?.layers.find((candidate) => candidate.type === "symbol")?.id;
    map.addSource(HEATMAP, { type: "geojson", data });
    map.addLayer(layer, before);
  };
  map.on("style.load", add);
  map.on("idle", add);
  if (map.isStyleLoaded()) add();
  return () => {
    map.off("style.load", add);
    map.off("idle", add);
    if (map.getLayer(HEATMAP)) map.removeLayer(HEATMAP);
    if (map.getSource(HEATMAP)) map.removeSource(HEATMAP);
  };
}
