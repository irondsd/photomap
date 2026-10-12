import { setWorkerUrl } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

// The bundled page can't find maplibre's worker next to itself; the server exposes it.
setWorkerUrl(new URL("/vendor/maplibre-gl-worker.mjs", location.href).href);

export const STYLE = {
  light: "https://tiles.openfreemap.org/styles/positron",
  dark: "https://tiles.openfreemap.org/styles/dark",
  /** Detailed and colourful: for finding a spot rather than for showing photos. */
  detailed: "https://tiles.openfreemap.org/styles/liberty",
};
