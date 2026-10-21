import { setWorkerUrl, type Map as MlMap, type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

// The bundled page can't find maplibre's worker next to itself; the server exposes it.
setWorkerUrl(new URL("/vendor/maplibre-gl-worker.mjs", location.href).href);

export const STYLE = {
  light: "https://tiles.openfreemap.org/styles/positron",
  dark: "https://tiles.openfreemap.org/styles/dark",
  /** Detailed and colourful: for finding a spot rather than for showing photos. */
  detailed: "https://tiles.openfreemap.org/styles/liberty",
};

/** Loads the light or dark base map, touching up the dark one on the way in. */
export function setMapTheme(map: MlMap, dark: boolean) {
  if (dark) map.setStyle(STYLE.dark, { transformStyle: (_, next) => liftDark(next) });
  else map.setStyle(STYLE.light);
}

/**
 * OpenFreeMap's dark style is much flatter than Positron: it has no layer for protected
 * areas, water is barely off the background, and labels are dim. Brings it up to roughly
 * the same contrast as the light map.
 */
function liftDark(style: StyleSpecification): StyleSpecification {
  const layers = style.layers.map((l) => {
    if (l.id === "water" && l.type === "fill") return { ...l, paint: { ...l.paint, "fill-color": "rgb(38, 42, 48)" } };
    if (l.id === "waterway" && l.type === "line") return { ...l, paint: { ...l.paint, "line-color": "rgb(38, 42, 48)" } };
    if (l.id.startsWith("place_") && l.type === "symbol") {
      return { ...l, paint: { ...l.paint, "text-color": "rgb(135, 135, 135)" } };
    }
    return l;
  });
  // Same layer Positron draws, in the same spot: right above the background.
  const bg = layers.findIndex((l) => l.type === "background");
  layers.splice(bg + 1, 0, {
    id: "park",
    type: "fill",
    source: "openmaptiles",
    "source-layer": "park",
    filter: ["match", ["geometry-type"], ["MultiPolygon", "Polygon"], true, false],
    paint: { "fill-color": "rgb(24, 27, 24)" },
  });
  return { ...style, layers };
}

/**
 * MapLibre opens the compact attribution expanded; on small maps it covers half the view.
 * Starts it collapsed (it's still one click on the ⓘ away).
 */
export function collapseAttribution(map: MlMap) {
  const collapse = () => {
    const el = map.getContainer().querySelector(".maplibregl-ctrl-attrib");
    el?.classList.remove("maplibregl-compact-show");
    el?.removeAttribute("open");
  };
  map.once("load", collapse);
  map.once("idle", collapse);
}
