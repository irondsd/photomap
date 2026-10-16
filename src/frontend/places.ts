import type { LatLon } from "./coords";

export interface Place {
  at: LatLon;
  name: string;
  /** City, region, country: what tells two "Main Street"s apart. */
  context: string;
  /** [west, south, east, north], for areas big enough to frame rather than pin. */
  bounds: [number, number, number, number] | null;
}

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: {
    name?: string;
    housenumber?: string;
    street?: string;
    district?: string;
    city?: string;
    county?: string;
    state?: string;
    country?: string;
    /** [minLon, maxLat, maxLon, minLat] */
    extent?: [number, number, number, number];
  };
}

export function toPlace(f: PhotonFeature): Place | null {
  const p = f.properties;
  const [lon, lat] = f.geometry.coordinates;
  const address = [p.street, p.housenumber].filter(Boolean).join(" ");
  const name = p.name ?? address;
  if (!name) return null;
  const context = [p.name ? address : null, p.district, p.city, p.state, p.country]
    .filter((s): s is string => !!s && s !== name)
    .filter((s, i, all) => all.indexOf(s) === i)
    .join(", ");
  const e = p.extent;
  return { at: { lat, lon }, name, context, bounds: e ? [e[0], e[3], e[2], e[1]] : null };
}

// Photon (OpenStreetMap data, by komoot) is built for search-as-you-type and needs no key.
// Nominatim's usage policy forbids autocomplete, so it isn't used here.
const PHOTON = "https://photon.komoot.io/api/";
const LANGS = ["en", "de", "fr"];

/** Places matching `query`, ranked closer to `near` when given. */
export async function searchPlaces(
  query: string,
  near: { at: LatLon; zoom: number } | null,
  signal: AbortSignal,
): Promise<Place[]> {
  const url = new URL(PHOTON);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "6");
  const lang = navigator.language.slice(0, 2);
  url.searchParams.set("lang", LANGS.includes(lang) ? lang : "en");
  if (near) {
    url.searchParams.set("lat", near.at.lat.toFixed(4));
    url.searchParams.set("lon", near.at.lon.toFixed(4));
    url.searchParams.set("zoom", String(Math.round(near.zoom)));
  }
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Place search failed (${res.status})`);
  const body = (await res.json()) as { features: PhotonFeature[] };
  return body.features.map(toPlace).filter((p): p is Place => p !== null);
}
