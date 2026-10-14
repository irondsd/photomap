import { useEffect, useRef } from "react";
import { Map as MlMap, Marker, NavigationControl, ScaleControl, type LngLatBoundsLike } from "maplibre-gl";
import type { BBox, Points } from "./data";
import type { Cluster } from "./clusterClient";
import { nf } from "./data";
import { STYLE } from "./map";

export interface MapViewProps {
  points: Points;
  clusters: Cluster[];
  initial: { center: [number, number]; zoom: number } | null;
  initialBounds: LngLatBoundsLike | null;
  dark: boolean;
  highlight: number | null;
  onView(bbox: BBox, zoom: number): void;
  onClusterClick(c: Cluster): void;
  onReady(map: MlMap): void;
}

/** Normalizes the visible bounds into a [-180, 180] bbox (west > east when crossing the antimeridian). */
function viewBBox(map: MlMap): BBox {
  const b = map.getBounds();
  const s = Math.max(-90, b.getSouth());
  const n = Math.min(90, b.getNorth());
  let w = b.getWest();
  let e = b.getEast();
  if (e - w >= 360) return [-180, s, 180, n];
  const wrap = (x: number) => ((((x + 180) % 360) + 360) % 360) - 180;
  w = wrap(w);
  e = wrap(e);
  return [w, s, e, n];
}

function markerSize(count: number): number {
  if (count <= 1) return 44;
  return Math.round(Math.min(84, 48 + 12 * Math.log10(count)));
}

interface Entry {
  marker: Marker;
  el: HTMLDivElement;
  cluster: Cluster;
}

export function MapView(props: MapViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const markers = useRef(new Map<string, Entry>());
  const ping = useRef<Marker | null>(null);
  const cb = useRef(props);
  cb.current = props;

  // Create the map once.
  useEffect(() => {
    const map = new MlMap({
      container: container.current!,
      style: props.dark ? STYLE.dark : STYLE.light,
      center: props.initial?.center ?? [10, 30],
      zoom: props.initial?.zoom ?? 1.5,
      bounds: props.initial ? undefined : (props.initialBounds ?? undefined),
      fitBoundsOptions: { padding: 60, maxZoom: 12 },
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
    });
    map.touchZoomRotate.disableRotation();
    map.addControl(new NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new ScaleControl({ maxWidth: 100 }), "bottom-left");
    mapRef.current = map;
    const entries = markers.current;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let last = 0;
    const report = () => {
      last = performance.now();
      cb.current.onView(viewBBox(map), map.getZoom());
    };
    // Re-cluster at most every 150ms while moving, and always when movement stops.
    const onMove = () => {
      if (timer) return;
      const wait = Math.max(0, 150 - (performance.now() - last));
      timer = setTimeout(() => {
        timer = null;
        report();
      }, wait);
    };
    map.on("move", onMove);
    map.on("moveend", report);
    map.once("load", () => {
      report();
      cb.current.onReady(map);
    });
    return () => {
      if (timer) clearTimeout(timer);
      map.remove();
      mapRef.current = null;
      entries.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the map is created once; theme changes go through setStyle below.
  }, []);

  // Theme switch.
  useEffect(() => {
    mapRef.current?.setStyle(props.dark ? STYLE.dark : STYLE.light);
  }, [props.dark]);

  // Sync photo markers with the latest clusters, reusing elements where possible.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const points = props.points;
    const next = new Set<string>();
    for (const c of props.clusters) {
      const key = c.cid >= 0 ? `c${c.cid}` : `p${c.rep}`;
      next.add(key);
      let entry = markers.current.get(key);
      if (!entry) {
        const el = document.createElement("div");
        el.className = "pm-marker";
        const img = document.createElement("img");
        img.alt = "";
        img.decoding = "async";
        img.draggable = false;
        img.onerror = () => el.classList.add("pm-marker--broken");
        el.appendChild(img);
        const badge = document.createElement("span");
        badge.className = "pm-badge";
        el.appendChild(badge);
        const created: Entry = { el, cluster: c, marker: new Marker({ element: el, anchor: "center" }).setLngLat([c.lon, c.lat]).addTo(map) };
        el.addEventListener("click", (ev) => {
          ev.stopPropagation();
          cb.current.onClusterClick(created.cluster);
        });
        entry = created;
        markers.current.set(key, entry);
      }
      entry.cluster = c;
      entry.marker.setLngLat([c.lon, c.lat]);
      const size = markerSize(c.count);
      entry.el.style.setProperty("--size", `${size}px`);
      entry.el.style.zIndex = String(Math.min(9999, c.count));
      const img = entry.el.firstChild as HTMLImageElement;
      const src = `/thumbs/s/${points.id[c.rep]}`;
      if (img.getAttribute("src") !== src) {
        entry.el.classList.remove("pm-marker--broken");
        img.src = src;
      }
      const badge = entry.el.lastChild as HTMLSpanElement;
      const isVideo = c.count === 1 && points.kind[c.rep] === 2;
      badge.textContent = c.count > 1 ? (c.count >= 10000 ? `${Math.round(c.count / 1000)}k` : nf.format(c.count)) : isVideo ? "▶" : "";
      badge.hidden = !badge.textContent;
      entry.el.title = c.count > 1 ? `${nf.format(c.count)} photos` : "";
    }
    for (const [key, entry] of markers.current) {
      if (!next.has(key)) {
        entry.marker.remove();
        markers.current.delete(key);
      }
    }
  }, [props.clusters, props.points]);

  // Location ping for the hovered photo.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const i = props.highlight;
    if (i == null || Number.isNaN(props.points.lat[i]!)) {
      ping.current?.remove();
      return;
    }
    if (!ping.current) {
      const el = document.createElement("div");
      el.className = "pm-ping";
      ping.current = new Marker({ element: el });
    }
    ping.current.setLngLat([props.points.lon[i]!, props.points.lat[i]!]).addTo(map);
  }, [props.highlight, props.points]);

  return <div ref={container} className="map" />;
}
