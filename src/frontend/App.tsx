import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Map as MlMap, LngLatBoundsLike } from "maplibre-gl";
import { ALL_KINDS, inBBox, loadPoints, lowerBound, passesPhotoFilter, type BBox, type Points, type Range } from "./data";
import { ClusterClient, type Cluster, type ClusterResult } from "./clusterClient";
import { MapView } from "./MapView";
import { Timeline } from "./Timeline";
import { Sidebar, type SidebarTab } from "./Sidebar";
import { Viewer } from "./Viewer";
import { AddFolder, Library, ScanProgress, type ScanStatus, type Stats } from "./Library";
import { Gallery } from "./Gallery";
import { PeopleView, personName } from "./People";
import { albumRequest, AlbumEditDialog, AlbumHeader, AlbumList, AlbumPicker } from "./AlbumViews";
import { Icon, IconButton } from "./Icons";
import { afterOverlayClose } from "./history";
import type { AlbumCatalog, AlbumSummary } from "../albums";
import type { PersonDetail } from "../people/store";
import { withPhotoVisibility, type PhotoVisibility } from "../photo-visibility";
import { HidePrivateContext, PhotoVisibilityContext } from "./photoVisibility";

type Mode = "map" | "gallery" | "albums" | "people";
const PRIVATE_ALBUM = -1;
const HIDDEN_PEOPLE = -1;
interface Destination {
  mode: Mode;
  album: number | null;
  person?: number | null;
}

function mapGroup(album: number | null, person: number | null) {
  if (person != null) return `person:${person}`;
  return album == null ? null : `album:${album}`;
}

// ---------------------------------------------------------------- URL state
interface HashState {
  mode: Mode | null;
  album: number | null;
  person: number | null;
  map: { center: [number, number]; zoom: number } | null;
  t: Range | null;
}

function readHash(allowPrivate = false): HashState {
  const q = new URLSearchParams(location.hash.slice(1));
  const m = q.get("map")?.split(",").map(Number);
  const t = q.get("t")?.split(",").map(Number);
  const v = q.get("view");
  const rawAlbum = q.get("album");
  const parsedAlbum = rawAlbum ? Number(rawAlbum) : NaN;
  const album = Number.isSafeInteger(parsedAlbum) && parsedAlbum >= 0 ? parsedAlbum : null;
  const rawPerson = q.get("person");
  const person = Number(rawPerson);
  return {
    mode: v === "gallery" || v === "map" || v === "albums" || v === "people" ? v : null,
    album:
      v === "albums" && rawAlbum === "private" && allowPrivate
        ? PRIVATE_ALBUM
        : v === "gallery" || v === "people"
          ? null
          : album,
    person:
      v === "people" && rawPerson === "hidden"
        ? HIDDEN_PEOPLE
        : (v === "people" || (v === "map" && album == null)) && Number.isSafeInteger(person) && person > 0
          ? person
          : null,
    map: m && m.length === 3 && m.every(Number.isFinite) ? { center: [m[1]!, m[0]!], zoom: m[2]! } : null,
    t: t && t.length === 2 && t.every(Number.isFinite) && t[0]! < t[1]! ? [t[0]!, t[1]!] : null,
  };
}

function viewHash({ mode, album, person }: Destination, map: MlMap | null, t: Range | null) {
  const q = new URLSearchParams();
  q.set("view", mode);
  if (album != null) q.set("album", album === PRIVATE_ALBUM ? "private" : String(album));
  if (person != null) q.set("person", person === HIDDEN_PEOPLE ? "hidden" : String(person));
  if (map) {
    const c = map.getCenter();
    q.set("map", `${c.lat.toFixed(5)},${c.lng.toFixed(5)},${map.getZoom().toFixed(2)}`);
  }
  if (t) q.set("t", `${Math.round(t[0])},${Math.round(t[1])}`);
  return `#${q.toString().replaceAll("%2C", ",")}`;
}

// ---------------------------------------------------------------- helpers
const KIND_FILTERS = [
  { label: "All", mask: ALL_KINDS },
  { label: "Photos", mask: 1 | 2 },
  { label: "Videos", mask: 4 },
] as const;

/** Bounds of geotagged photos passing the filter, or null. */
function boundsOf(
  p: Points,
  range: Range | null,
  kinds: number,
  membership: Uint8Array | null = null,
): LngLatBoundsLike | null {
  let w = 180,
    s = 90,
    e = -180,
    n = -90,
    found = 0;
  const lo = range ? lowerBound(p.t, p.dated, range[0]) : 0;
  const hi = range ? lowerBound(p.t, p.dated, range[1]) : p.n;
  for (let i = lo; i < hi; i++) {
    const la = p.lat[i]!;
    if (Number.isNaN(la) || (membership && !membership[i]) || !passesPhotoFilter(p, i, range, kinds)) continue;
    const lo2 = p.lon[i]!;
    if (la < s) s = la;
    if (la > n) n = la;
    if (lo2 < w) w = lo2;
    if (lo2 > e) e = lo2;
    found++;
  }
  if (!found) return null;
  const pad = 0.002;
  return [
    [w - pad, s - pad],
    [e + pad, n + pad],
  ];
}

type ThemePref = "system" | "light" | "dark";

function savedTheme(): ThemePref {
  try {
    const t = localStorage.getItem("pm.theme");
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
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

/** The chosen theme and whether it resolves to dark. The resolved theme is put on <html data-theme>. */
function useTheme() {
  const [pref, setPrefState] = useState<ThemePref>(savedTheme);
  const systemDark = usePrefersDark();
  const dark = pref === "system" ? systemDark : pref === "dark";
  // A layout effect, so it lands before the timeline's effect repaints its canvas from the CSS colors.
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);
  const setPref = useCallback((t: ThemePref) => {
    setPrefState(t);
    try {
      if (t === "system") localStorage.removeItem("pm.theme");
      else localStorage.setItem("pm.theme", t);
    } catch {
      // Storage can be unavailable; the theme just won't be remembered.
    }
  }, []);
  return { pref, setPref, dark };
}

const THEMES: { value: ThemePref; label: string; icon: React.ReactNode }[] = [
  {
    value: "system",
    label: "System theme",
    icon: (
      <>
        <rect x="2" y="3" width="12" height="8.5" rx="1.5" />
        <path d="M5.5 14h5M8 11.5V14" />
      </>
    ),
  },
  {
    value: "light",
    label: "Light theme",
    icon: (
      <>
        <circle cx="8" cy="8" r="2.75" />
        <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.06 1.06M11.54 11.54l1.06 1.06M3.4 12.6l1.06-1.06M11.54 4.46l1.06-1.06" />
      </>
    ),
  },
  {
    value: "dark",
    label: "Dark theme",
    icon: <path d="M13.5 9.8A5.75 5.75 0 0 1 6.2 2.5a5.75 5.75 0 1 0 7.3 7.3Z" />,
  },
];

function ThemeSwitch(props: { value: ThemePref; onChange: (t: ThemePref) => void }) {
  return (
    <div className="segmented segmented-icons" role="group" aria-label="Theme">
      {THEMES.map((t) => (
        <button
          key={t.value}
          aria-pressed={props.value === t.value}
          aria-label={t.label}
          title={t.label}
          onClick={() => props.onChange(t.value)}
        >
          <svg viewBox="0 0 16 16" aria-hidden>
            {t.icon}
          </svg>
        </button>
      ))}
    </div>
  );
}

const EMPTY = new Int32Array(0);
const EMPTY_RESULT: ClusterResult = { clusters: [], visible: EMPTY, total: 0 };

function savedMode(): Mode {
  try {
    const mode = localStorage.getItem("pm.view");
    return mode === "gallery" || mode === "albums" || mode === "people" ? mode : "map";
  } catch {
    return "map";
  }
}

export function App() {
  const initialHash = useRef(readHash()).current;
  const { pref: theme, setPref: setTheme, dark } = useTheme();
  const [destination, setDestination] = useState<Destination>(() => ({
    mode: initialHash.mode ?? (initialHash.album != null ? "map" : savedMode()),
    album: initialHash.album,
    person: initialHash.person,
  }));
  const { mode, album: albumId, person: personRoute = null } = destination;
  const hiddenPeopleOpen = mode === "people" && personRoute === HIDDEN_PEOPLE;
  const personId = hiddenPeopleOpen ? null : personRoute;
  const privateOpen = mode === "albums" && albumId === PRIVATE_ALBUM;
  const privateEntry = useRef(false);
  const [showPrivate, setShowPrivate] = useState(false);
  const visibility: PhotoVisibility = privateOpen ? "private" : showPrivate ? "all" : "public";
  const [privacyRevision, setPrivacyRevision] = useState(0);
  const dataKey = `${visibility}:${privacyRevision}`;
  const currentDataKey = useRef(dataKey);
  useLayoutEffect(() => {
    currentDataKey.current = dataKey;
  }, [dataKey]);
  // Each view is built the first time it's shown, then kept (map position, gallery scroll).
  // A map created while hidden has no size and would fit its bounds to nothing.
  const [galleryMounted, setGalleryMounted] = useState(mode === "gallery");
  const galleryScroll = useRef(0);
  const [mapMounted, setMapMounted] = useState(mode === "map");
  const activate = useCallback((next: Destination) => {
    privateEntry.current = next.mode === "albums" && next.album === PRIVATE_ALBUM;
    setDestination((current) =>
      current.mode === next.mode && current.album === next.album && (current.person ?? null) === (next.person ?? null)
        ? current
        : next,
    );
    const m = next.mode;
    if (m === "gallery") setGalleryMounted(true);
    if (m === "map") setMapMounted(true);
    try {
      localStorage.setItem("pm.view", m);
    } catch {
      // Storage can be unavailable (private mode, blocked); the view just won't be remembered.
    }
  }, []);
  const [indexData, setIndexData] = useState<{ key: string; points: Points; stats: Stats } | null>(null);
  const points = indexData?.key === dataKey ? indexData.points : null;
  const stats = indexData?.key === dataKey ? indexData.stats : null;
  const [indexError, setIndexError] = useState<{ key: string; text: string } | null>(null);
  const refreshSequence = useRef(0);
  const [scan, setScan] = useState<ScanStatus | null>(null);
  const [kinds, setKinds] = useState<number>(ALL_KINDS);
  const [selection, setSelection] = useState<Range | null>(initialHash.t);
  const [view, setView] = useState<{ bbox: BBox; zoom: number } | null>(null);
  const [clusterQuery, setClusterQuery] = useState<{
    result: ClusterResult;
    membership: Uint8Array | null;
    points: Points;
  } | null>(null);
  const [followMap, setFollowMap] = useState(false);
  const [tab, setTab] = useState<SidebarTab>("map");
  // Photo ids, so the viewer stays on the same photo when the points are reloaded.
  const [viewer, setViewer] = useState<{ ids: Uint32Array; index: number } | null>(null);
  const [hoverPoint, setHoverPoint] = useState<{ points: Points; index: number } | null>(null);
  const hover = hoverPoint?.points === points ? hoverPoint.index : null;
  const setHover = useCallback(
    (index: number | null) => {
      setHoverPoint(index != null && points ? { points, index } : null);
    },
    [points],
  );
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [albumCatalog, setAlbumCatalog] = useState<{ key: string; value: AlbumCatalog } | null>(null);
  const catalog = albumCatalog?.key === dataKey ? albumCatalog.value : null;
  const [catalogError, setCatalogError] = useState("");
  const [albumsRevision, setAlbumsRevision] = useState(0);
  const [albumMembers, setAlbumMembers] = useState<{ key: string; album: number; ids: number[] } | null>(null);
  const [membersError, setMembersError] = useState<{ album: number; text: string } | null>(null);
  const [albumPicker, setAlbumPicker] = useState<{ ids: number[]; onDone?: () => void } | null>(null);
  const [albumEdit, setAlbumEdit] = useState<{ album: AlbumSummary; remove: boolean } | null>(null);
  const [coverDraft, setCoverDraft] = useState<{
    albumId: number;
    candidate: number | null;
    saving: boolean;
    error: string;
  } | null>(null);
  const [albumNotice, setAlbumNotice] = useState("");
  const [privacyNotice, setPrivacyNotice] = useState<{
    text: string;
    undo?: { ids: number[]; makePrivate: boolean };
  } | null>(null);
  const [undoingPrivacy, setUndoingPrivacy] = useState(false);
  const privacyChannel = useRef<BroadcastChannel | null>(null);
  const mapRef = useRef<MlMap | null>(null);
  const mapPosition = useRef<HashState["map"]>(null);
  const pendingGroupFit = useRef(mode === "map" && !initialHash.map ? mapGroup(albumId, personId) : null);
  const [personData, setPersonData] = useState<{ key: string; value?: PersonDetail; error?: string } | null>(null);
  const [peopleRevision, setPeopleRevision] = useState(0);
  const peopleChanged = () => setPeopleRevision((value) => value + 1);
  const personKey = `${dataKey}:${personId}`;
  const personDetail = personData?.key === personKey ? personData.value : undefined;
  const personError = personData?.key === personKey ? (personData.error ?? "") : "";
  const [photoFocus, setPhotoFocus] = useState<{ center: [number, number]; id: number } | null>(null);
  const clientRef = useRef<ClusterClient | null>(null);
  const clusterFilter = useRef<{ points: Points; membership: Uint8Array | null } | null>(null);
  const loadedVersion = useRef<{ key: string; value: string } | null>(null);

  const navigate = useCallback(
    (m: Mode, album: number | null = null, range = selection, replace = false, person: number | null = null) => {
      const next = { mode: m, album, person };
      const hash = viewHash(next, mapRef.current, range);
      if (replace) history.replaceState(history.state, "", hash);
      else if (m !== mode || album !== albumId || person !== personRoute) {
        history.replaceState(history.state, "", viewHash(destination, mapRef.current, selection));
        const fromAlbumIndex = m === "albums" && album != null && mode === "albums" && albumId == null;
        const enteringPeopleGroup = m === "people" && person != null && mode === "people";
        const fromPeopleIndex = enteringPeopleGroup && personRoute == null;
        const fromHiddenPeople = enteringPeopleGroup && hiddenPeopleOpen;
        history.pushState(
          fromAlbumIndex
            ? { fromAlbumIndex: true }
            : fromPeopleIndex
              ? { fromPeopleIndex: true }
              : fromHiddenPeople
                ? { fromHiddenPeople: true }
                : null,
          "",
          hash,
        );
      }
      activate(next);
      setSelection(range);
    },
    [activate, albumId, destination, hiddenPeopleOpen, mode, personRoute, selection],
  );
  const backToAlbums = () => {
    if (history.state?.fromAlbumIndex) history.back();
    else navigate("albums", null, selection, true);
  };
  const backToPeople = () => {
    if (history.state?.fromPeopleIndex || history.state?.fromHiddenPeople) history.back();
    else navigate("people", null, selection, true, personDetail?.person.hidden ? HIDDEN_PEOPLE : null);
  };

  const hidePrivate = useCallback(() => {
    setShowPrivate(false);
    if (privateEntry.current) activate({ mode: "albums", album: null });
    setViewer(null);
    setAlbumPicker(null);
    setAlbumEdit(null);
    setLibraryOpen(false);
    setCoverDraft(null);
    setPhotoFocus(null);
    setAlbumNotice("");
    setPrivacyNotice(null);
  }, [activate]);

  // ------------------------------------------------------------ data loading
  const refresh = useCallback(async () => {
    if (currentDataKey.current !== dataKey) return;
    const sequence = ++refreshSequence.current;
    const current = () => currentDataKey.current === dataKey && refreshSequence.current === sequence;
    try {
      const response = await fetch(withPhotoVisibility("/api/stats", visibility));
      if (!response.ok) throw new Error("Couldn't load photos. Try again.");
      const nextStats = (await response.json()) as Stats;
      if (!current()) return;
      if (loadedVersion.current?.key !== dataKey || loadedVersion.current.value !== nextStats.version) {
        const nextPoints = await loadPoints(visibility);
        if (!current()) return;
        loadedVersion.current = { key: dataKey, value: nextStats.version };
        setIndexData({ key: dataKey, stats: nextStats, points: nextPoints });
      }
      setIndexError(null);
    } catch (error) {
      if (current()) setIndexError({ key: dataKey, text: (error as Error).message });
    }
  }, [dataKey, visibility]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const albumsChanged = useCallback(() => setAlbumsRevision((n) => n + 1), []);
  useEffect(() => {
    const request = new AbortController();
    setCatalogError("");
    albumRequest<AlbumCatalog>(withPhotoVisibility("albums", visibility), "GET", undefined, request.signal)
      .then((value) => {
        if (!request.signal.aborted) setAlbumCatalog({ key: dataKey, value });
      })
      .catch((err: Error) => {
        if (!request.signal.aborted) setCatalogError(err.message);
      });
    return () => request.abort();
  }, [points, albumsRevision, dataKey, visibility]);

  useEffect(() => {
    if (albumId == null || albumId <= 0) return;
    const request = new AbortController();
    setMembersError(null);
    albumRequest<number[]>(withPhotoVisibility(`albums/${albumId}`, visibility), "GET", undefined, request.signal)
      .then((ids) => {
        if (!request.signal.aborted) setAlbumMembers({ key: dataKey, album: albumId, ids });
      })
      .catch((err: Error) => {
        if (!request.signal.aborted) setMembersError({ album: albumId, text: err.message });
      });
    return () => request.abort();
  }, [albumId, points, albumsRevision, dataKey, visibility]);

  const activeAlbum = albumId === 0 ? catalog?.favorites : catalog?.albums.find((a) => a.id === albumId);
  const albumIds =
    albumId === 0
      ? catalog?.favorites.ids
      : albumMembers?.key === dataKey && albumMembers.album === albumId
        ? albumMembers.ids
        : undefined;
  const favorites = useMemo(() => new Set(catalog?.favorites.ids), [catalog?.favorites.ids]);
  const idIndex = useMemo(() => {
    const m = new Map<number, number>();
    if (points) for (let i = 0; i < points.n; i++) m.set(points.id[i]!, i);
    return m;
  }, [points]);
  const indexOf = useCallback((id: number) => idIndex.get(id), [idIndex]);
  useEffect(() => {
    if (personId == null) return;
    const controller = new AbortController();
    albumRequest<PersonDetail>(
      withPhotoVisibility(`people/${personId}/detail`, visibility),
      "GET",
      undefined,
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) setPersonData({ key: personKey, value });
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) setPersonData({ key: personKey, error: error.message });
      });
    return () => controller.abort();
  }, [personId, personKey, visibility, points, peopleRevision]);
  const pickingCover = mode === "albums" && coverDraft?.albumId === albumId ? coverDraft : null;
  const canPickCover = albumIds?.some((id) => {
    const i = indexOf(id);
    return i != null && points!.kind[i] !== 2;
  });

  useEffect(() => {
    setCoverDraft(null);
  }, [mode, albumId]);

  useEffect(() => {
    if (!pickingCover || pickingCover.saving) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setCoverDraft(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pickingCover]);

  const saveCover = async () => {
    if (!pickingCover || pickingCover.candidate == null || pickingCover.saving) return;
    const { albumId, candidate } = pickingCover;
    setCoverDraft({ ...pickingCover, saving: true, error: "" });
    try {
      await albumRequest(`albums/${albumId}/cover`, "PUT", { photoId: candidate });
      setAlbumCatalog((current) =>
        current?.key === dataKey
          ? {
              ...current,
              value: {
                ...current.value,
                albums: current.value.albums.map((album) =>
                  album.id === albumId ? { ...album, coverId: candidate } : album,
                ),
              },
            }
          : current,
      );
      setCoverDraft((draft) => (draft?.albumId === albumId && draft.saving ? null : draft));
      setAlbumNotice("Album cover updated");
      albumsChanged();
    } catch (error) {
      setCoverDraft((draft) =>
        draft?.albumId === albumId && draft.saving
          ? { ...draft, saving: false, error: (error as Error).message }
          : draft,
      );
    }
  };
  const albumMask = useMemo(() => {
    if (!points || albumId == null || privateOpen) return null;
    const mask = new Uint8Array(points.n);
    for (const id of albumIds ?? []) {
      const i = idIndex.get(id);
      if (i != null) mask[i] = 1;
    }
    return mask;
  }, [albumId, albumIds, idIndex, points, privateOpen]);
  const personMask = useMemo(() => {
    if (!points || personId == null) return null;
    const mask = new Uint8Array(points.n);
    for (const id of personDetail?.ids ?? []) {
      const index = indexOf(id);
      if (index != null) mask[index] = 1;
    }
    return mask;
  }, [points, personId, personDetail, indexOf]);
  const personBounds = useMemo(
    () => (points && personMask && personDetail ? boundsOf(points, null, ALL_KINDS, personMask) : null),
    [points, personMask, personDetail],
  );
  const mapMembership = mode === "map" ? (personMask ?? albumMask) : null;
  const groupKey = mapGroup(albumId, personId);
  const result =
    clusterQuery?.points === points && clusterQuery.membership === mapMembership ? clusterQuery.result : EMPTY_RESULT;
  const albumBounds = useMemo(
    () => (points && albumMask && albumIds ? boundsOf(points, null, ALL_KINDS, albumMask) : null),
    [points, albumMask, albumIds],
  );

  const groupBounds = personId != null ? personBounds : albumBounds;

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
      if (s && (s.running || s.version !== loadedVersion.current?.value)) {
        // Refresh the map periodically during long scans so photos appear as they're indexed.
        if (!s.running || performance.now() - lastRefresh > 8000) {
          lastRefresh = performance.now();
          await refresh();
        }
      }
      if (!stop) timer = setTimeout(loop, s?.running ? 1000 : 4000);
    };
    loop();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [pollScan, refresh]);

  // ------------------------------------------------------------ clustering
  useEffect(() => {
    const client = new ClusterClient((result) => {
      if (clusterFilter.current) setClusterQuery({ result, ...clusterFilter.current });
    });
    clientRef.current = client;
    return () => client.dispose();
  }, []);

  useEffect(() => {
    if (!points) return;
    clientRef.current!.load(points);
  }, [points]);

  useEffect(() => {
    clusterFilter.current = points ? { points, membership: mapMembership } : null;
    if (!points) return;
    clientRef.current!.filter(selection, kinds, mapMembership);
  }, [points, selection, kinds, mapMembership]);

  const onView = useCallback((bbox: BBox, zoom: number) => {
    const center = mapRef.current?.getCenter();
    if (center) mapPosition.current = { center: [center.lng, center.lat], zoom };
    setView({ bbox, zoom });
    clientRef.current?.query(bbox, zoom);
  }, []);

  // ------------------------------------------------------------ derived lists
  const noLocation = useMemo(() => {
    if (!points) return EMPTY;
    const out: number[] = [];
    for (let i = points.n - 1; i >= 0; i--) {
      if ((!mapMembership || mapMembership[i]) && Number.isNaN(points.lat[i]!) && passesPhotoFilter(points, i, selection, kinds))
        out.push(i);
    }
    // Undated photos sit at the end of the index; show them last.
    return Int32Array.from(
      out.sort((a, b) => (Number.isNaN(points.t[a]!) ? 1 : 0) - (Number.isNaN(points.t[b]!) ? 1 : 0)),
    );
  }, [points, selection, kinds, mapMembership]);

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
  useEffect(() => {
    const onHash = () => {
      const h = readHash(privateEntry.current);
      activate({ mode: h.mode ?? (h.album == null ? savedMode() : "map"), album: h.album, person: h.person });
      setSelection(h.t);
      if (h.map) {
        mapPosition.current = h.map;
        mapRef.current?.jumpTo({ center: h.map.center, zoom: h.map.zoom });
      }
      pendingGroupFit.current = h.mode === "map" && !h.map ? mapGroup(h.album, h.person) : null;
    };
    window.addEventListener("hashchange", onHash);
    window.addEventListener("popstate", onHash);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("popstate", onHash);
    };
  }, [activate]);

  useEffect(() => {
    const id = setTimeout(() => {
      history.replaceState(history.state, "", viewHash(destination, mapRef.current, selection));
    }, 300);
    return () => clearTimeout(id);
  }, [destination, view, selection]);

  // The map was hidden with display: none; let it measure itself again.
  const mapHasView = view != null;
  useEffect(() => {
    if (mode !== "map" || !mapHasView) return;
    const frame = requestAnimationFrame(() => {
      const map = mapRef.current;
      if (!map) return;
      map.resize();
      if (photoFocus) {
        setPhotoFocus(null);
        map.flyTo({ center: photoFocus.center, zoom: Math.max(map.getZoom(), 15), duration: 900 });
        const i = indexOf(photoFocus.id);
        if (i != null) {
          setHover(i);
          setTimeout(() => setHoverPoint((h) => (h?.points === points && h.index === i ? null : h)), 3500);
        }
      } else if (pendingGroupFit.current != null && pendingGroupFit.current === groupKey && groupBounds) {
        pendingGroupFit.current = null;
        map.fitBounds(groupBounds, { padding: 64, maxZoom: 14, duration: 700 });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [mode, mapHasView, groupKey, groupBounds, indexOf, photoFocus, points, setHover]);

  // ------------------------------------------------------------ actions
  const fitToPhotos = useCallback(() => {
    if (!points || !mapRef.current) return;
    const b = boundsOf(points, selection, kinds, mapMembership);
    if (b) mapRef.current.fitBounds(b, { padding: 80, maxZoom: 14, duration: 700 });
  }, [points, selection, kinds, mapMembership]);

  const showGroupMap = () => {
    pendingGroupFit.current = groupKey;
    setKinds(ALL_KINDS);
    setTab("map");
    navigate("map", albumId, null, false, personId);
  };

  const saveFavorite = async (id: number, favorite: boolean) => {
    await albumRequest(withPhotoVisibility(`photos/${id}/favorite`, visibility), "PUT", { favorite });
    setAlbumCatalog((current) =>
      current?.key === dataKey
        ? {
            ...current,
            value: {
              ...current.value,
              favorites: {
                ...current.value.favorites,
                ids: favorite
                  ? [...new Set([...current.value.favorites.ids, id])]
                  : current.value.favorites.ids.filter((item) => item !== id),
              },
            },
          }
        : current,
    );
    albumsChanged();
  };

  const removeFromAlbum = async (ids: number[]) => {
    await albumRequest(`albums/${albumId}/members`, "POST", { ids, remove: true });
    const removed = new Set(ids);
    setAlbumMembers((current) =>
      current?.key === dataKey && current.album === albumId
        ? { ...current, ids: current.ids.filter((id) => !removed.has(id)) }
        : current,
    );
    albumsChanged();
  };

  useEffect(() => {
    if (!albumNotice) return;
    const timer = setTimeout(() => setAlbumNotice(""), 3500);
    return () => clearTimeout(timer);
  }, [albumNotice]);

  const invalidatePrivacy = useCallback(() => {
    setPrivacyRevision((revision) => revision + 1);
    setViewer(null);
    setAlbumPicker(null);
    setCoverDraft(null);
    setPhotoFocus(null);
  }, []);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel("photomap-photo-privacy");
    privacyChannel.current = channel;
    channel.onmessage = invalidatePrivacy;
    return () => {
      privacyChannel.current = null;
      channel.close();
    };
  }, [invalidatePrivacy]);

  const changePrivacy = async (ids: number[], makePrivate: boolean, undo = false) => {
    const { changed } = await albumRequest<{ changed: number[] }>("photos/privacy", "PUT", {
      ids,
      private: makePrivate,
    });
    if (changed.length) privacyChannel.current?.postMessage("changed");
    if (visibility === "all" && currentDataKey.current === dataKey) {
      // The visible set stays the same in this mode. Refresh the flags in place.
      await refresh();
    } else {
      invalidatePrivacy();
    }
    const items = changed.length === 1 ? "1 item" : `${changed.length} items`;
    setPrivacyNotice({
      text: !changed.length
        ? "These items are already up to date."
        : makePrivate
          ? `Made ${items} private`
          : `Removed ${items} from Private`,
      undo: !undo && changed.length ? { ids: changed, makePrivate: !makePrivate } : undefined,
    });
  };

  useEffect(() => {
    if (!privacyNotice || undoingPrivacy) return;
    const timer = setTimeout(() => setPrivacyNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [privacyNotice, undoingPrivacy]);

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
      if (currentDataKey.current !== dataKey || clusterFilter.current?.points !== points) return;
      if (r.leaves) openViewer(r.leaves, 0);
      else mapRef.current?.easeTo({ center: [c.lon, c.lat], zoom: Math.min(r.zoom + 0.2, 18), duration: 500 });
    },
    [result.visible, openViewer, dataKey, points],
  );

  const showOnMap = useCallback(
    (i: number) => {
      if (!points) return;
      const center: [number, number] = [points.lon[i]!, points.lat[i]!];
      const id = points.id[i]!;
      afterOverlayClose(() => {
        setTab("map");
        pendingGroupFit.current = null;
        setPhotoFocus({ center, id });
        navigate("map", albumId === PRIVATE_ALBUM ? null : albumId, selection, false, personId);
      });
      setViewer(null);
    },
    [points, albumId, personId, selection, navigate],
  );

  const openPerson = useCallback(
    (person: number) => {
      afterOverlayClose(() => navigate("people", null, selection, false, person));
      setViewer(null);
    },
    [navigate, selection],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (mode !== "map" || viewer || libraryOpen || (e.target as HTMLElement)?.closest?.("input, textarea, dialog"))
        return;
      if (e.key === "Escape" && selection) setSelection(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, viewer, libraryOpen, selection]);

  // ------------------------------------------------------------ render
  const isEmpty = stats != null && stats.total === 0 && !privateOpen;
  const initialBounds = useMemo(
    () => (points && !initialHash.map ? boundsOf(points, null, ALL_KINDS) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the first load positions the map.
    [points !== null],
  );
  const paused = viewer != null || libraryOpen || albumPicker != null || albumEdit != null;
  const openAlbumPicker = (ids: number[], onDone?: () => void) => setAlbumPicker({ ids, onDone });
  const albumLabel = activeAlbum?.name ?? (catalog && !catalogError ? "Album unavailable" : "Loading album…");
  const albumProblem =
    catalogError ||
    (membersError?.album === albumId ? membersError?.text : "") ||
    (catalog && albumId != null && !activeAlbum ? "This album is no longer available." : "");

  const app = (
    <div className="app">
      {showPrivate && (
        <div className="private-visibility-bar">
          <span role="status">
            <Icon name="lock" /> Private photos visible
          </span>
          <button className="btn btn-small" onClick={hidePrivate}>
            Hide now
          </button>
        </div>
      )}
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          Photomap
        </div>
        <div className="segmented" role="group" aria-label="View">
          <button
            aria-pressed={mode === "map"}
            onClick={() => {
              if (mode !== "map") navigate("map");
            }}
          >
            Map
          </button>
          <button aria-pressed={mode === "gallery"} onClick={() => navigate("gallery")}>
            Gallery
          </button>
          <button
            aria-pressed={mode === "albums"}
            onClick={() => {
              if (mode === "albums" && albumId != null) backToAlbums();
              else navigate("albums");
            }}
          >
            Albums
          </button>
          <button
            aria-pressed={mode === "people"}
            onClick={() => {
              if (mode === "people" && personRoute != null) backToPeople();
              else navigate("people");
            }}
          >
            People
          </button>
        </div>
        <div className="segmented segmented-kinds" role="group" aria-label="Media type" hidden={mode === "people"}>
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
              {scan.phase === "walking"
                ? "Scanning…"
                : `Indexing ${Math.round((scan.processed / Math.max(1, scan.found)) * 100)}%`}
            </button>
          )}
          <ThemeSwitch value={theme} onChange={setTheme} />
          <button className="btn" onClick={() => setLibraryOpen(true)}>
            Library
          </button>
        </div>
      </header>

      <main className="main">
        {indexError?.key === dataKey && !points && (
          <div className="empty photo-load-error">
            <p role="alert">{indexError.text}</p>
            <button className="btn" onClick={refresh}>
              Try again
            </button>
          </div>
        )}
        <div className="map-layout" hidden={mode !== "map"}>
          <div className="map-col">
            <div className="map-wrap">
              {points && mapMounted && !privateOpen && (
                <MapView
                  points={points}
                  clusters={result.clusters}
                  active={mode === "map"}
                  range={selection}
                  kinds={kinds}
                  membership={mapMembership}
                  initial={mapPosition.current ?? initialHash.map}
                  initialBounds={initialBounds}
                  dark={dark}
                  highlight={hover}
                  onView={onView}
                  onClusterClick={onClusterClick}
                  onReady={(m) => (mapRef.current = m)}
                />
              )}
              {mode === "map" && groupKey != null && (
                <div className="map-album-filter">
                  <span>
                    {personId != null ? (
                      <>
                        Viewing photos of{" "}
                        <strong>
                          {personDetail
                            ? personName(personDetail.person)
                            : personError
                              ? "Person unavailable"
                              : "Loading person…"}
                        </strong>
                      </>
                    ) : (
                      <>
                        Viewing album <strong>{albumLabel}</strong>
                      </>
                    )}
                  </span>
                  <IconButton
                    name="close"
                    label={personId == null ? "Clear album filter" : "Clear person filter"}
                    onClick={() => {
                      pendingGroupFit.current = null;
                      navigate("map", null, selection, true);
                    }}
                  />
                </div>
              )}
              {points && result.total > 0 && (
                <button
                  className="btn btn-float fit-btn"
                  onClick={fitToPhotos}
                  title="Zoom the map to the photos in the current selection"
                >
                  Fit to photos
                </button>
              )}
              {isEmpty && (
                <div className="welcome">
                  <div className="welcome-card">
                    <h1>Your photos, on a map</h1>
                    <p className="dim">
                      Point Photomap at a folder. It reads every photo and video inside it, including subfolders, and
                      places them by their GPS data. Nothing leaves your computer, and your files only change when you
                      ask.
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
                membership={mapMembership}
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
        {galleryMounted && points && !privateOpen && (
          <div className="gallery-layout" hidden={mode !== "gallery"}>
            <Gallery
              points={points}
              kinds={kinds}
              active={mode === "gallery"}
              scrollPosition={galleryScroll}
              paused={paused}
              indexOf={indexOf}
              onOpen={openViewer}
              onLocationsChanged={refresh}
              favorites={favorites}
              onAddToAlbum={openAlbumPicker}
              onChangePrivacy={changePrivacy}
            />
          </div>
        )}
        {mode === "albums" &&
          albumId == null &&
          (catalog ? (
            <AlbumList
              albums={[catalog.favorites, ...catalog.albums]}
              onOpen={(id) => navigate("albums", id)}
              onCreate={() => openAlbumPicker([])}
              onOpenPrivate={() => {
                setKinds(ALL_KINDS);
                navigate("albums", PRIVATE_ALBUM);
              }}
            />
          ) : (
            <div className="empty">
              {catalogError ? (
                <>
                  <p role="alert">{catalogError}</p>
                  <button className="btn" onClick={albumsChanged}>
                    Try again
                  </button>
                </>
              ) : (
                "Loading albums…"
              )}
            </div>
          ))}
        {mode === "people" && (
          <PeopleView
            key={dataKey}
            personId={personId}
            hiddenOpen={hiddenPeopleOpen}
            visibility={visibility}
            points={points}
            person={personDetail?.person}
            membership={personDetail ? personMask : null}
            hasLocations={personDetail && points ? personBounds != null : null}
            personError={personError}
            revision={peopleRevision}
            reload={peopleChanged}
            onOpen={(id) => navigate("people", null, selection, false, id)}
            onOpenHidden={() => navigate("people", null, selection, false, HIDDEN_PEOPLE)}
            onMap={showGroupMap}
            onBack={backToPeople}
            onMerged={(id) =>
              afterOverlayClose(() => {
                navigate("people", null, selection, true, id);
                peopleChanged();
              })
            }
            renderGallery={(membership, editingPerson, coverPicker) =>
              points && (
                <Gallery
                  points={points}
                  kinds={1 | 2}
                  active
                  paused={paused || editingPerson}
                  indexOf={indexOf}
                  onOpen={openViewer}
                  onLocationsChanged={refresh}
                  favorites={favorites}
                  membership={membership}
                  coverPicker={coverPicker}
                  onAddToAlbum={openAlbumPicker}
                  onChangePrivacy={changePrivacy}
                />
              )
            }
          />
        )}
        {privateOpen && (
          <div className="album-detail">
            <header className="album-heading album-detail-heading">
              <div className="album-title">
                <IconButton name="back" label="All albums" onClick={backToAlbums} />
                <div>
                  <h1>Private</h1>
                  <p className="dim">Hidden during normal browsing</p>
                </div>
              </div>
              {!showPrivate && (
                <button className="btn album-action" onClick={() => setShowPrivate(true)}>
                  <Icon name="lock" /> Show private photos
                </button>
              )}
            </header>
            {points ? (
              <Gallery
                points={points}
                kinds={kinds}
                active
                paused={paused}
                indexOf={indexOf}
                onOpen={openViewer}
                onLocationsChanged={refresh}
                favorites={favorites}
                onAddToAlbum={openAlbumPicker}
                onChangePrivacy={changePrivacy}
                emptyMessage={points.n ? undefined : "Use Make private on a photo or selection to add it here."}
              />
            ) : (
              indexError?.key !== dataKey && <div className="empty">Loading private photos…</div>
            )}
          </div>
        )}
        {albumId != null && !privateOpen && (
          <div className="album-detail" hidden={mode !== "albums"} key={albumId}>
            {activeAlbum && (
              <AlbumHeader
                album={activeAlbum}
                hasLocations={albumIds && points ? albumBounds != null : null}
                onBack={backToAlbums}
                onMap={showGroupMap}
                onRename={() => setAlbumEdit({ album: activeAlbum, remove: false })}
                onDelete={() => setAlbumEdit({ album: activeAlbum, remove: true })}
                onPickCover={
                  canPickCover
                    ? () =>
                        setCoverDraft({
                          albumId,
                          candidate: null,
                          saving: false,
                          error: "",
                        })
                    : undefined
                }
                coverPicker={
                  pickingCover
                    ? {
                        ...pickingCover,
                        onSave: saveCover,
                        onCancel: () => setCoverDraft(null),
                      }
                    : undefined
                }
              />
            )}
            {albumProblem ? (
              <div className="empty">
                <p role="alert">{albumProblem}</p>
                <div className="row">
                  <button className="btn" onClick={backToAlbums}>
                    All albums
                  </button>
                  <button className="btn" onClick={albumsChanged}>
                    Try again
                  </button>
                </div>
              </div>
            ) : activeAlbum && points && albumIds && albumMask ? (
              <Gallery
                points={points}
                kinds={kinds}
                active={mode === "albums"}
                paused={paused}
                indexOf={indexOf}
                onOpen={openViewer}
                onLocationsChanged={refresh}
                favorites={favorites}
                membership={albumMask}
                oldestFirst={albumId !== 0}
                onAddToAlbum={openAlbumPicker}
                onChangePrivacy={changePrivacy}
                onRemoveFromAlbum={albumId === 0 ? undefined : removeFromAlbum}
                coverPicker={
                  pickingCover
                    ? {
                        current: activeAlbum.coverId,
                        candidate: pickingCover.candidate,
                        saving: pickingCover.saving,
                        onPick: (id) => setCoverDraft((draft) => draft && { ...draft, candidate: id, error: "" }),
                      }
                    : undefined
                }
                emptyMessage={
                  albumId === 0 && !albumIds.length
                    ? "Star a photo or video to find it here."
                    : !albumIds.length
                      ? "Select photos in the gallery to add them to this album."
                      : undefined
                }
              />
            ) : (
              <div className="empty">Loading album…</div>
            )}
          </div>
        )}
      </main>

      {viewer && points && indexOf(viewer.ids[viewer.index]!) != null && (
        <Viewer
          points={points}
          ids={viewer.ids}
          index={viewer.index}
          indexOf={indexOf}
          onIndex={(index) => setViewer((v) => v && { ...v, index })}
          onClose={() => setViewer(null)}
          onShowOnMap={!privateOpen || showPrivate ? showOnMap : undefined}
          onLocationChange={refresh}
          favorites={favorites}
          albumsRevision={albumsRevision}
          albumPickerOpen={albumPicker != null}
          onAddToAlbum={(id) => openAlbumPicker([id])}
          peopleRevision={peopleRevision}
          onOpenPerson={openPerson}
          onFavorite={saveFavorite}
          onChangePrivacy={changePrivacy}
          onDeleted={(id) => {
            // On to the next photo (the previous one at the end); closed when none are left.
            setViewer((v) => {
              const ids = v?.ids.filter((x) => x !== id);
              return ids?.length ? { ids, index: Math.min(v!.index, ids.length - 1) } : null;
            });
            refresh();
          }}
        />
      )}
      {albumPicker && (
        <AlbumPicker
          albums={catalog?.albums ?? []}
          ids={albumPicker.ids}
          onClose={() => setAlbumPicker(null)}
          onSaved={(name) => {
            albumPicker.onDone?.();
            setAlbumPicker(null);
            albumsChanged();
            setAlbumNotice(albumPicker.ids.length ? `Added to ${name}` : `Created ${name}`);
          }}
        />
      )}
      {albumEdit && (
        <AlbumEditDialog
          album={albumEdit.album}
          remove={albumEdit.remove}
          onClose={() => setAlbumEdit(null)}
          onSaved={() => {
            if (albumEdit.remove) afterOverlayClose(backToAlbums);
            setAlbumEdit(null);
            albumsChanged();
          }}
        />
      )}
      {albumNotice && (
        <div className="album-notice" role="status">
          {albumNotice}
        </div>
      )}
      {privacyNotice && (
        <div className="album-notice privacy-notice">
          <span role="status">{privacyNotice.text}</span>
          {privacyNotice.undo && (
            <button
              className="btn btn-small"
              disabled={undoingPrivacy}
              onClick={async () => {
                const undo = privacyNotice.undo!;
                setUndoingPrivacy(true);
                try {
                  await changePrivacy(undo.ids, undo.makePrivate, true);
                } catch (error) {
                  setPrivacyNotice({ ...privacyNotice, text: (error as Error).message });
                } finally {
                  setUndoingPrivacy(false);
                }
              }}
            >
              Undo
            </button>
          )}
        </div>
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
  return (
    <PhotoVisibilityContext value={visibility}>
      <HidePrivateContext value={showPrivate ? hidePrivate : null}>{app}</HidePrivateContext>
    </PhotoVisibilityContext>
  );
}
