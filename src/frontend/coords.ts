export interface LatLon {
  lat: number;
  lon: number;
}

const valid = (lat: number, lon: number): LatLon | null =>
  Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;

/**
 * Reads coordinates the way people paste them:
 *   "48.858370, 2.294481"           (Google Maps right-click)
 *   "48.858370 2.294481"
 *   "https://www.google.com/maps/@48.858370,2.294481,15z" or ".../place/.../@48.85,2.29,..."
 *   "https://www.openstreetmap.org/#map=15/48.8584/2.2945"
 */
export function parseCoords(input: string): LatLon | null {
  const s = input.trim();
  if (!s) return null;
  const num = "(-?\\d{1,3}(?:\\.\\d+)?)";
  const at = new RegExp(`@${num},${num}`).exec(s);
  if (at) return valid(+at[1]!, +at[2]!);
  const osm = new RegExp(`map=\\d+(?:\\.\\d+)?/${num}/${num}`).exec(s);
  if (osm) return valid(+osm[1]!, +osm[2]!);
  const pair = new RegExp(`^${num}\\s*[,;\\s]\\s*${num}$`).exec(s);
  if (pair) return valid(+pair[1]!, +pair[2]!);
  return null;
}

export const formatCoords = (c: LatLon) => `${c.lat.toFixed(6)}, ${c.lon.toFixed(6)}`;
