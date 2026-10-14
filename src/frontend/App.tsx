import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Map as MlMap, LngLatBoundsLike } from "maplibre-gl";
import { ALL_KINDS, inBBox, loadPoints, lowerBound, nf, type BBox, type Points, type Range } from "./data";
import { ClusterClient, type Cluster, type ClusterResult } from "./clusterClient";
import { MapView } from "./MapView";
import { Timeline } from "./Timeline";
import { Sidebar, type SidebarTab } from "./Sidebar";
import { Viewer } from "./Viewer";
import { AddFolder, Library, ScanProgress, type ScanStatus, type Stats } from "./Library";
import { Gallery } from "./Gallery";

type Mode = "map" | "gallery";

// ---------------------------------------------------------------- URL state: #view=gallery&map=lat,lon,zoom&t=from,to
interface HashState {
  mode: Mode | null;
  map: { center: [number, number]; zoom: number } | null;
  t: Range | null;
}

function readHash(): HashState {
  const q = new URLSearchParams(location.hash.slice(1));
  const m = q.get("map")?.split(",").map(Number);
  const t = q.get("t")?.split(",").map(Number);
  const v = q.get("view");
  return {
    mode: v === "gallery" || v === "map" ? v : null,
    map: m && m.length === 3 && m.every(Number.isFinite) ? { center: [m[1]!, m[0]!], zoom: m[2]! } : null,
    t: t && t.length === 2 && t.every(Number.isFinite) && t[0]! < t[1]! ? [t[0]!, t[1]!] : null,
  };
}

function writeHash(mode: Mode, map: MlMap | null, t: Range | null) {
  const q = new URLSearchParams();
  if (mode === "gallery") q.set("view", "gallery");
  if (map) {
    const c = map.getCenter();
    q.set("map", `${c.lat.toFixed(5)},${c.lng.toFixed(5)},${map.getZoom().toFixed(2)}`);
  }
  if (t) q.set("t", `${Math.round(t[0])},${Math.round(t[1])}`);
  history.replaceState(null, "", `#${q.toString().replaceAll("%2C", ",")}`);
}

// ---------------------------------------------------------------- helpers
const KIND_FILTERS = [
  { label: "All", mask: ALL_KINDS },
  { label: "Photos", mask: 1 | 2 },
  { label: "Videos", mask: 4 },
] as const;

function passes(p: Points, i: number, range: Range | null, kinds: number) {
  if (!((1 << p.kind[i]!) & kinds)) return false;
  if (!range) return true;
  const t = p.t[i]!;
  return t >= range[0] && t < range[1];
}

/** Bounds of geotagged photos passing the filter, or null. */
function boundsOf(p: Points, range: Range | null, kinds: number): LngLatBoundsLike | null {
  let w = 180, s = 90, e = -180, n = -90, found = 0;
  const lo = range ? lowerBound(p.t, p.dated, range[0]) : 0;
  const hi = range ? lowerBound(p.t, p.dated, range[1]) : p.n;
  for (let i = lo; i < hi; i++) {
    const la = p.lat[i]!;
    if (Number.isNaN(la) || !passes(p, i, range, kinds)) continue;
    const lo2 = p.lon[i]!;
    if (la < s) s = la;
    if (la > n) n = la;
    if (lo2 < w) w = lo2;
    if (lo2 > e) e = lo2;
    found++;
  }
  if (!found) return null;
  const pad = 0.002;
  return [[w - pad, s - pad], [e + pad, n + pad]];
}

function usePrefersDark() {
  const [dark, setDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => setDark(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return dark;
}

const EMPTY = new Int32Array(0);

function savedMode(): Mode {
  try {
    return localStorage.getItem("pm.view") === "gallery" ? "gallery" : "map";
  } catch {
    return "map";
  }
}

export function App() {
  const initialHash = useRef(readHash()).current;
  const dark = usePrefersDark();
  const [mode, setModeState] = useState<Mode>(() => initialHash.mode ?? savedMode());
  // Each view is built the first time it's shown, then kept (map position, gallery scroll).
  // A map created while hidden has no size and would fit its bounds to nothing.
  const [galleryMounted, setGalleryMounted] = useState(mode === "gallery");
  const [mapMounted, setMapMounted] = useState(mode === "map");
  const setMode = useCallback((m: Mode) => {
    setModeState(m);
    if (m === "gallery") setGalleryMounted(true);
    else setMapMounted(true);
    try {
      localStorage.setItem("pm.view", m);
    } catch {
      // Storage can be unavailable (private mode, blocked); the view just won't be remembered.
    }
  }, []);
  const [points, setPoints] = useState<Points | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [scan, setScan] = useState<ScanStatus | null>(null);
  const [kinds, setKinds] = useState<number>(ALL_KINDS);
  const [selection, setSelection] = useState<Range | null>(initialHash.t);
  const [view, setView] = useState<{ bbox: BBox; zoom: number } | null>(null);
  const [result, setResult] = useState<ClusterResult>({ clusters: [], visible: EMPTY, total: 0 });
  const [followMap, setFollowMap] = useState(false);
  const [tab, setTab] = useState<SidebarTab>("map");
  // Photo ids, so the viewer stays on the same photo when the points are reloaded.
  const [viewer, setViewer] = useState<{ ids: Uint32Array; index: number } | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const mapRef = useRef<MlMap | null>(null);
  const clientRef = useRef<ClusterClient | null>(null);
  const loadedVersion = useRef<string | null>(null);

  // ------------------------------------------------------------ data loading
  const refresh = useCallback(async () => {
    const s = (await (await fetch("/api/stats")).json()) as Stats;
    setStats(s);
    if (loadedVersion.current !== s.version) {
      loadedVersion.current = s.version;
      setPoints(await loadPoints());
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Poll scan status while a scan runs; reload the index as it lands.
  const pollScan = useCallback(async () => {
    const s = (await (await fetch("/api/scan")).json()) as ScanStatus;
    setScan(s);
    return s;
  }, []);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    let lastRefresh = 0;
    const loop = async () => {
      const s = await pollScan().catch(() => null);
      if (stop) return;
      if (s && (s.running || s.version !== loadedVersion.current)) {
        // Refresh the map periodically during long scans so photos appear as they're indexed.
        if (!s.running || performance.now() - lastRefresh > 8000) {
          lastRefresh = performance.now();
          await refresh();
        }
      }
      timer = setTimeout(loop, s?.running ? 1000 : 4000);
    };
    loop();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [pollScan, refresh]);

  // ------------------------------------------------------------ clustering
  useEffect(() => {
    const client = new ClusterClient(setResult);
    clientRef.current = client;
    return () => client.dispose();
  }, []);

  useEffect(() => {
    if (!points) return;
    clientRef.current!.load(points);
    clientRef.current!.filter(selection, kinds);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the effect below re-filters on selection/kind changes.
  }, [points]);

  useEffect(() => {
    if (points) clientRef.current!.filter(selection, kinds);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- new points are loaded and filtered above.
  }, [selection, kinds]);

  const onView = useCallback((bbox: BBox, zoom: number) => {
    setView({ bbox, zoom });
    clientRef.current?.query(bbox, zoom);
  }, []);

  // ------------------------------------------------------------ derived lists
  const noLocation = useMemo(() => {
    if (!points) return EMPTY;
    const out: number[] = [];
    for (let i = points.n - 1; i >= 0; i--) {
      if (Number.isNaN(points.lat[i]!) && passes(points, i, selection, kinds)) out.push(i);
    }
    // Undated photos sit at the end of the index; show them last.
    return Int32Array.from(out.sort((a, b) => (Number.isNaN(points.t[a]!) ? 1 : 0) - (Number.isNaN(points.t[b]!) ? 1 : 0)));
  }, [points, selection, kinds]);

  const mapMask = useMemo(() => {
    if (!followMap || !points || !view) return null;
    const m = new Uint8Array(points.n);
    for (let i = 0; i < points.n; i++) {
      const la = points.lat[i]!;
      if (!Number.isNaN(la) && inBBox(la, points.lon[i]!, view.bbox)) m[i] = 1;
    }
    return m;
  }, [followMap, points, view]);

  // ------------------------------------------------------------ URL sync
  // replaceState (below) doesn't fire hashchange, so this only reacts to edits and pasted links.
  useEffect(() => {
    const onHash = () => {
      const h = readHash();
      if (h.mode) setMode(h.mode);
      setSelection(h.t);
      if (h.map) mapRef.current?.jumpTo({ center: h.map.center, zoom: h.map.zoom });
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [setMode]);

  useEffect(() => {
    const id = setTimeout(() => writeHash(mode, mapRef.current, selection), 300);
    return () => clearTimeout(id);
  }, [mode, view, selection]);

  // The map was hidden with display: none; let it measure itself again.
  useEffect(() => {
    if (mode === "map") requestAnimationFrame(() => mapRef.current?.resize());
  }, [mode]);

  // ------------------------------------------------------------ actions
  const fitToPhotos = useCallback(() => {
    if (!points || !mapRef.current) return;
    const b = boundsOf(points, selection, kinds);
    if (b) mapRef.current.fitBounds(b, { padding: 80, maxZoom: 14, duration: 700 });
  }, [points, selection, kinds]);

  const idIndex = useMemo(() => {
    const m = new Map<number, number>();
    if (points) for (let i = 0; i < points.n; i++) m.set(points.id[i]!, i);
    return m;
  }, [points]);
  const indexOf = useCallback((id: number) => idIndex.get(id), [idIndex]);

  /** Opens the viewer on a list of point indices. */
  const openViewer = useCallback(
    (list: Int32Array, index: number) => {
      if (points) setViewer({ ids: Uint32Array.from(list, (i) => points.id[i]!), index });
    },
    [points],
  );

  const onClusterClick = useCallback(
    async (c: Cluster) => {
      if (c.cid < 0) {
        const k = result.visible.indexOf(c.rep);
        if (k >= 0) openViewer(result.visible, k);
        else openViewer(Int32Array.of(c.rep), 0);
        return;
      }
      const r = await clientRef.current!.expand(c.cid);
      if (r.leaves) openViewer(r.leaves, 0);
      else mapRef.current?.easeTo({ center: [c.lon, c.lat], zoom: Math.min(r.zoom + 0.2, 18), duration: 500 });
    },
    [result.visible, openViewer],
  );

  const showOnMap = useCallback(
    (i: number) => {
      if (!points || !mapRef.current) return;
      setViewer(null);
      setTab("map");
      setMode("map");
      // After the map is visible again and has its size back.
      requestAnimationFrame(() => {
        const map = mapRef.current;
        if (!map) return;
        map.resize();
        map.flyTo({ center: [points.lon[i]!, points.lat[i]!], zoom: Math.max(map.getZoom(), 15), duration: 900 });
      });
      setHover(i);
      setTimeout(() => setHover((h) => (h === i ? null : h)), 3500);
    },
    [points, setMode],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (mode !== "map" || viewer || libraryOpen || (e.target as HTMLElement)?.closest?.("input, textarea")) return;
      if (e.key === "Escape" && selection) setSelection(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, viewer, libraryOpen, selection]);

  // ------------------------------------------------------------ render
  const isEmpty = stats != null && stats.total === 0;
  useEffect(() => {
    if (isEmpty && mode === "gallery") setMode("map");
  }, [isEmpty, mode, setMode]);
  const initialBounds = useMemo(
    () => (points && !initialHash.map ? boundsOf(points, null, ALL_KINDS) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the first load positions the map.
    [points !== null],
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          Photomap
        </div>
        <div className="segmented" role="group" aria-label="View">
          <button aria-pressed={mode === "map"} onClick={() => setMode("map")}>
            Map
          </button>
          <button aria-pressed={mode === "gallery"} disabled={isEmpty} onClick={() => setMode("gallery")}>
            Gallery
          </button>
        </div>
        <div className="segmented segmented-kinds" role="group" aria-label="Media type">
          {KIND_FILTERS.map((f) => (
            <button key={f.label} aria-pressed={kinds === f.mask} onClick={() => setKinds(f.mask)}>
              {f.label}
            </button>
          ))}
        </div>
        <div className="topbar-right">
          {scan?.running && (
            <button className="pill" onClick={() => setLibraryOpen(true)}>
              <span className="spinner" aria-hidden />
              {scan.phase === "walking" ? "Scanning…" : `Indexing ${Math.round((scan.processed / Math.max(1, scan.found)) * 100)}%`}
            </button>
          )}
          {stats && stats.total > 0 && (
            <span className="dim small">
              {mode === "map" ? `${nf.format(result.total)} on map · ` : ""}
              {nf.format(stats.total)} total
            </span>
          )}
          <button className="btn" onClick={() => setLibraryOpen(true)}>
            Library
          </button>
        </div>
      </header>

      <main className="main">
        <div className="map-layout" hidden={mode !== "map"}>
          <div className="map-col">
            <div className="map-wrap">
              {points && mapMounted && (
                <MapView
                  points={points}
                  clusters={result.clusters}
                  initial={initialHash.map}
                  initialBounds={initialBounds}
                  dark={dark}
                  highlight={hover}
                  onView={onView}
                  onClusterClick={onClusterClick}
                  onReady={(m) => (mapRef.current = m)}
                />
              )}
              {points && result.total > 0 && (
                <button className="btn btn-float fit-btn" onClick={fitToPhotos} title="Zoom the map to the photos in the current selection">
                  Fit to photos
                </button>
              )}
              {isEmpty && (
                <div className="welcome">
                  <div className="welcome-card">
                    <h1>Your photos, on a map</h1>
                    <p className="dim">
                      Point Photomap at a folder. It reads every photo and video inside it, including subfolders, and places them by their GPS
                      data. Nothing leaves your computer and your files are never modified.
                    </p>
                    {scan?.running ? <ScanProgress scan={scan} /> : <AddFolder autoFocus onAdded={() => pollScan()} />}
                  </div>
                </div>
              )}
            </div>
            {points && points.n > 0 && (
              <Timeline
                points={points}
                kinds={kinds}
                selection={selection}
                onSelect={setSelection}
                mapMask={mapMask}
                followMap={followMap}
                onFollowMap={setFollowMap}
                hoverT={hover != null ? points.t[hover]! : null}
                dark={dark}
              />
            )}
          </div>
          {points && points.n > 0 && (
            <Sidebar
              points={points}
              tab={tab}
              onTab={setTab}
              onMap={result.visible}
              noLocation={noLocation}
              onOpen={openViewer}
              onHover={setHover}
            />
          )}
        </div>
        {galleryMounted && points && (
          <div className="gallery-layout" hidden={mode !== "gallery"}>
            <Gallery
              points={points}
              kinds={kinds}
              active={mode === "gallery"}
              paused={viewer != null || libraryOpen}
              indexOf={indexOf}
              onOpen={openViewer}
              onLocationsChanged={refresh}
            />
          </div>
        )}
      </main>

      {viewer && points && (
        <Viewer
          points={points}
          ids={viewer.ids}
          index={viewer.index}
          indexOf={indexOf}
          onIndex={(index) => setViewer((v) => v && { ...v, index })}
          onClose={() => setViewer(null)}
          onShowOnMap={showOnMap}
          onLocationChange={refresh}
        />
      )}
      {libraryOpen && (
        <Library
          stats={stats}
          scan={scan}
          onClose={() => setLibraryOpen(false)}
          onChanged={() => {
            pollScan();
            refresh();
          }}
        />
      )}
    </div>
  );
}
