import { setWorkerUrl, type Map as MlMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

// The bundled page can't find maplibre's worker next to itself; the server exposes it.
setWorkerUrl(new URL("/vendor/maplibre-gl-worker.mjs", location.href).href);

export const STYLE = {
  light: "https://tiles.openfreemap.org/styles/positron",
  dark: "https://tiles.openfreemap.org/styles/dark",
  /** Detailed and colourful: for finding a spot rather than for showing photos. */
  detailed: "https://tiles.openfreemap.org/styles/liberty",
};

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
