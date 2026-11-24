import { usePhotoUrls } from "./photoVisibility";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { formatMonth, formatYear, localStorageGet, localStorageSet, nf, SOURCE, type Points } from "./data";
import { buildLayout, firstVisible, galleryOrder, groupAt, HEADER_H, rowHeightFor, type Layout } from "./galleryLayout";
import { BulkDateDialog } from "./BulkDate";
import { BulkLocationDialog } from "./BulkLocation";
import { Icon } from "./Icons";

// Room on the left for the day headers' select-all checks.
const LEFT = 44;
const SCRUBBER_W = 56;
/** Phones: the gutter for the day checkboxes and the date rail shrink (styles.css matches at 560px). */
const LEFT_NARROW = 12;
const SCRUBBER_W_NARROW = 40;
const NARROW_W = 560;
const OVERSCAN = 800;
/** How long a finger rests on a photo to select it. */
const LONG_PRESS_MS = 450;
// Shift/Cmd/Ctrl + scroll (or a trackpad pinch) scales the rows by this much.
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 3;
const ZOOM_KEY = "pm.galleryZoom";

interface GalleryProps {
  points: Points;
  kinds: number;
  /** False while the gallery is hidden behind the map view. */
  active: boolean;
  /** Keyboard shortcuts pause while the viewer or a dialog is open. */
  paused: boolean;
  indexOf(id: number): number | undefined;
  onOpen(list: Int32Array, index: number): void;
  /** Locations or dates were changed in bulk; reload the index. */
  onLocationsChanged(): void;
  favorites: ReadonlySet<number>;
  membership?: Uint8Array;
  oldestFirst?: boolean;
  emptyMessage?: string;
  scrollPosition?: RefObject<number>;
  onAddToAlbum(ids: number[], onDone: () => void): void;
  onChangePrivacy(ids: number[], makePrivate: boolean): Promise<void>;
  onRemoveFromAlbum?(ids: number[]): Promise<void>;
  coverPicker?: {
    current: number | null;
    candidate: number | null;
    saving: boolean;
    onPick(id: number): void;
  };
}

export function Gallery({
  points,
  kinds,
  active,
  paused,
  indexOf,
  onOpen,
  onLocationsChanged,
  favorites,
  membership,
  oldestFirst,
  emptyMessage = "No photos match this filter.",
  scrollPosition,
  onAddToAlbum,
  onChangePrivacy,
  onRemoveFromAlbum,
  coverPicker,
}: GalleryProps) {
  const { thumbnail, photoUrl, visibility } = usePhotoUrls();
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [scrollTop, setScrollTop] = useState(() => scrollPosition?.current ?? 0);
  // Photo ids, so a selection survives the index being reloaded.
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const anchor = useRef<number | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkDateOpen, setBulkDateOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [albumError, setAlbumError] = useState("");

  useLayoutEffect(() => {
    const el = scroller.current!;
    const ro = new ResizeObserver(() => {
      // Hidden (display: none) reports 0; keep the last layout instead of collapsing it.
      if (el.clientWidth > 0) setBox({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const grouped = !membership;
  const order = useMemo(
    () => galleryOrder(points, kinds, membership, oldestFirst),
    [points, kinds, membership, oldestFirst],
  );
  const phone = box.w <= NARROW_W;
  const left = grouped ? (phone ? LEFT_NARROW : LEFT) : 16;
  const contentW = Math.max(0, box.w - left - (grouped ? (phone ? SCRUBBER_W_NARROW : SCRUBBER_W) : 16));
  const [zoom, setZoom] = useState(() => {
    const z = Number(localStorageGet(ZOOM_KEY));
    return z >= MIN_ZOOM && z <= MAX_ZOOM ? z : 1;
  });
  const layout = useMemo(
    () => (contentW > 0 ? buildLayout(points, order, contentW, left, rowHeightFor(contentW) * zoom, grouped) : null),
    [points, order, contentW, left, zoom, grouped],
  );

  // Scroll position, at most once per frame.
  const frame = useRef(0);
  const localScrollPosition = useRef(0);
  const saved = scrollPosition ?? localScrollPosition;
  const restoreScroll = useRef(true);
  useLayoutEffect(() => () => cancelAnimationFrame(frame.current), []);
  const onScroll = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const el = scroller.current;
      if (!el?.clientHeight || restoreScroll.current) return;
      saved.current = el.scrollTop;
      setScrollTop(el.scrollTop);
    });
  };

  // ------------------------------------------------------------ zoom
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const zoomRef = useRef(zoom);
  // The photo under the cursor when zooming started, kept there as the rows resize.
  const zoomAnchor = useRef<{ k: number; f: number; px: number; clientY: number } | null>(null);
  const zoomFrame = useRef(0);

  useEffect(() => {
    const el = scroller.current!;
    const onWheel = (e: WheelEvent) => {
      // Ctrl is also what a trackpad pinch reports.
      if (!e.shiftKey && !e.metaKey && !e.ctrlKey) return;
      e.preventDefault();
      const l = layoutRef.current;
      if (!l || !l.order.length) return;
      // Browsers turn Shift + wheel into horizontal scrolling.
      const delta = (e.deltaY || e.deltaX) * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 600 : 1);
      // Pinches report small deltas; a mouse notch is ~100.
      scaleTo(zoomRef.current * Math.exp(-delta * (e.ctrlKey && !e.shiftKey ? 0.01 : 0.002)), e.clientY);
    };
    /** Rows to scale `target`, keeping the photo under `clientY` in place. */
    const scaleTo = (target: number, clientY: number) => {
      const l = layoutRef.current;
      if (!l || !l.order.length) return;
      const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, target));
      if (z === zoomRef.current) return;
      zoomRef.current = z;
      if (!zoomAnchor.current) {
        const cy = clientY - content.current!.getBoundingClientRect().top;
        const k = Math.min(l.order.length - 1, firstVisible(l.y, l.h, l.order.length, cy));
        const y = l.y[k]!;
        const h = l.h[k]!;
        // Above the tile means a day header, which doesn't scale.
        zoomAnchor.current = cy < y ? { k, f: 0, px: cy - y, clientY } : { k, f: (cy - y) / h, px: 0, clientY };
      }
      cancelAnimationFrame(zoomFrame.current);
      zoomFrame.current = requestAnimationFrame(() => {
        setZoom(zoomRef.current);
        localStorageSet(ZOOM_KEY, String(zoomRef.current));
      });
    };
    // Two fingers pinch the rows bigger or smaller; one still scrolls.
    let pinch: { dist: number; zoom: number } | null = null;
    const fingers = (t: TouchList) => {
      const [a, b] = [t[0]!, t[1]!];
      return { dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), y: (a.clientY + b.clientY) / 2 };
    };
    const onTouchStart = (e: TouchEvent) => {
      pinch = e.touches.length === 2 ? { dist: Math.max(fingers(e.touches).dist, 1), zoom: zoomRef.current } : null;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      const f = fingers(e.touches);
      scaleTo((pinch.zoom * f.dist) / pinch.dist, f.y);
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinch = null;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchEnd);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, []);

  useLayoutEffect(() => {
    const a = zoomAnchor.current;
    zoomAnchor.current = null;
    if (!a || !layout || a.k >= layout.order.length) return;
    const el = scroller.current!;
    const at = content.current!.getBoundingClientRect().top + layout.y[a.k]! + a.f * layout.h[a.k]! + a.px;
    el.scrollTop += at - a.clientY;
    saved.current = el.scrollTop;
    setScrollTop(el.scrollTop);
  }, [layout]);

  // Wait for the photos to lay out before restoring a gallery that was hidden or reloaded.
  useLayoutEffect(() => {
    if (!active) {
      restoreScroll.current = true;
      return;
    }
    if (!restoreScroll.current || !layout) return;
    const el = scroller.current!;
    el.scrollTop = saved.current;
    saved.current = el.scrollTop;
    setScrollTop(el.scrollTop);
    restoreScroll.current = false;
  }, [active, layout, saved]);

  // ------------------------------------------------------------ selection
  const selecting = selected.size > 0;
  const idAt = (k: number) => points.id[layout!.order[k]!]!;

  const toggle = (k: number) => {
    const id = idAt(k);
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    anchor.current = k;
  };

  const selectRange = (k: number) => {
    const a = anchor.current ?? k;
    const [from, to] = a <= k ? [a, k] : [k, a];
    setSelected((s) => {
      const next = new Set(s);
      for (let j = from; j <= to; j++) next.add(idAt(j));
      return next;
    });
    anchor.current = k;
  };

  const toggleGroup = (gi: number) => {
    const g = layout!.groups[gi]!;
    let all = true;
    for (let j = g.start; j < g.end; j++) if (!selected.has(idAt(j))) all = false;
    setSelected((s) => {
      const next = new Set(s);
      for (let j = g.start; j < g.end; j++) {
        if (all) next.delete(idAt(j));
        else next.add(idAt(j));
      }
      return next;
    });
    anchor.current = g.start;
  };

  const clear = useCallback(() => {
    setSelected(new Set());
    anchor.current = null;
  }, []);

  // A long press selects, on touch screens where there's no hover to show the check.
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number; fired: boolean } | null>(null);
  const startPress = (k: number, e: React.PointerEvent) => {
    if (e.pointerType === "mouse") return;
    // A second finger is a pinch, not a press.
    if (press.current && !press.current.fired) {
      clearTimeout(press.current.timer);
      press.current = null;
      return;
    }
    const p = { x: e.clientX, y: e.clientY, fired: false, timer: setTimeout(() => {}, 0) };
    p.timer = setTimeout(() => {
      p.fired = true;
      navigator.vibrate?.(10);
      toggle(k);
    }, LONG_PRESS_MS);
    press.current = p;
  };
  const movePress = (e: React.PointerEvent) => {
    const p = press.current;
    if (p && !p.fired && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 8) {
      clearTimeout(p.timer);
      press.current = null;
    }
  };
  const endPress = () => {
    const p = press.current;
    if (p && !p.fired) {
      clearTimeout(p.timer);
      press.current = null;
    }
  };

  const onTileClick = (k: number, e: React.MouseEvent) => {
    // The click that ends a long press was the selection itself.
    if (press.current?.fired) {
      press.current = null;
      return;
    }
    if (e.shiftKey && (selecting || anchor.current != null)) selectRange(k);
    else if (selecting || e.metaKey || e.ctrlKey) toggle(k);
    else onOpen(layout!.order, k);
  };

  // Ids that disappeared (another filter, a removed folder) drop out of the selection.
  const visibleSelection = useMemo(() => {
    const ids: number[] = [];
    if (!layout) return ids;
    const inOrder = new Set<number>();
    for (const i of layout.order) inOrder.add(points.id[i]!);
    for (const id of selected) if (inOrder.has(id)) ids.push(id);
    return ids;
  }, [selected, layout, points]);

  const manualIds = useMemo(
    () => visibleSelection.filter((id) => points.source[indexOf(id) ?? -1] === SOURCE.manual),
    [visibleSelection, points, indexOf],
  );
  const manualDateIds = useMemo(
    () => visibleSelection.filter((id) => points.dateManual[indexOf(id) ?? -1] === 1),
    [visibleSelection, points, indexOf],
  );
  const privateIds = visibleSelection.filter((id) => points.isPrivate[indexOf(id) ?? -1] === 1);
  const publicIds = visibleSelection.filter((id) => points.isPrivate[indexOf(id) ?? -1] === 0);
  const changePrivacy = async (ids: number[], makePrivate: boolean) => {
    setBusy(true);
    setAlbumError("");
    try {
      await onChangePrivacy(ids, makePrivate);
      clear();
    } catch (err) {
      setAlbumError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!active || paused || coverPicker) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("input, textarea")) return;
      if (e.key === "Escape" && selected.size) {
        e.preventDefault();
        clear();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, paused, coverPicker, selected.size, clear]);

  const resetSelected = async () => {
    const n = manualIds.length;
    if (
      !confirm(
        `Undo the location you set on ${nf.format(n)} photo${n === 1 ? "" : "s"}?\n\nEach goes back to the location stored in its file, or to no location if the file has none.`,
      )
    )
      return;
    setBusy(true);
    try {
      const r = await fetch(photoUrl("/api/locations/reset"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: manualIds }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? "Couldn't reset");
      clear();
      onLocationsChanged();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const resetSelectedDates = async () => {
    const n = manualDateIds.length;
    if (
      !confirm(
        `Undo the date you set on ${nf.format(n)} photo${n === 1 ? "" : "s"}?\n\nEach goes back to the date stored in its file, or worked out from the files around it.`,
      )
    )
      return;
    setBusy(true);
    try {
      const r = await fetch(photoUrl("/api/dates/reset"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: manualDateIds }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? "Couldn't reset");
      clear();
      onLocationsChanged();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // ------------------------------------------------------------ render
  const items: React.ReactNode[] = [];
  if (layout) {
    const top = scrollTop - OVERSCAN;
    const bottom = scrollTop + box.h + OVERSCAN;
    for (let gi = groupAt(layout.groups, Math.max(0, top)); gi < layout.groups.length; gi++) {
      const g = layout.groups[gi]!;
      if (g.y > bottom) break;
      if (g.y + HEADER_H < top) continue;
      let all = g.end > g.start;
      for (let j = g.start; j < g.end && all; j++) if (!selected.has(idAt(j))) all = false;
      items.push(
        <div
          key={`g${g.start}`}
          className={`gheader ${all ? "is-selected" : ""}`}
          style={{ top: g.y, left, width: contentW }}
        >
          <button
            className="gcheck"
            aria-pressed={all}
            aria-label={`Select all photos from ${g.label}`}
            onClick={() => toggleGroup(gi)}
          />
          <span className="gheader-date">{g.label}</span>
          {g.places && <span className="gheader-places">{g.places}</span>}
        </div>,
      );
    }
    const n = layout.order.length;
    for (let k = firstVisible(layout.y, layout.h, n, top); k < n && layout.y[k]! <= bottom; k++) {
      const i = layout.order[k]!;
      const id = points.id[i]!;
      const sel = selected.has(id);
      const isVideo = points.kind[i] === 2;
      const isPrivate = points.isPrivate[i] === 1;
      const isFavorite = favorites.has(id);
      const currentCover = coverPicker?.current === id;
      items.push(
        <div
          key={id}
          className={`gtile ${sel ? "is-selected" : ""}`}
          style={{ left: layout.x[k], top: layout.y[k], width: layout.w[k], height: layout.h[k] }}
          onClick={coverPicker ? undefined : (e) => onTileClick(k, e)}
          onPointerDown={coverPicker ? undefined : (e) => startPress(k, e)}
          onPointerMove={movePress}
          onPointerUp={endPress}
          onPointerCancel={endPress}
          onContextMenu={(e) => press.current && e.preventDefault()}
        >
          <img
            src={thumbnail(id, "m")}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            onLoad={(e) => e.currentTarget.classList.add("is-loaded")}
          />
          {isVideo && <span className="gtile-video">▶</span>}
          {(isPrivate || isFavorite) && (
            <div className="gtile-badges">
              {isPrivate && (
                <span className="gtile-private" title="Private" role="img" aria-label="Private">
                  <Icon name="lock" />
                </span>
              )}
              {isFavorite && (
                <span className="gtile-star" title="Favorite" role="img" aria-label="Favorite">
                  <Icon name="star" />
                </span>
              )}
            </div>
          )}
          {Number.isNaN(points.lat[i]!) && (
            <span className="gtile-nogeo" title="No location">
              <svg viewBox="0 0 24 24" aria-hidden>
                <path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 11.6-4M18.3 8.2c.1.6.2 1.2.2 1.8 0 5-6.5 11-6.5 11" />
                <path d="M4 3l16 18" />
              </svg>
            </span>
          )}
          {coverPicker ? (
            <button
              type="button"
              className="cover-pick-tile"
              aria-label={
                isVideo ? "Video" : currentCover ? `Current cover, photo ${k + 1}` : `Choose photo ${k + 1} as cover`
              }
              aria-pressed={coverPicker.candidate === id}
              disabled={isVideo || coverPicker.saving}
              title={isVideo ? "Choose a photo for the cover" : undefined}
              onClick={() => coverPicker.onPick(id)}
            >
              {currentCover && <span>Current cover</span>}
            </button>
          ) : (
            <button
              className="gcheck"
              aria-pressed={sel}
              aria-label="Select photo"
              onClick={(e) => {
                e.stopPropagation();
                if (e.shiftKey && anchor.current != null) selectRange(k);
                else toggle(k);
              }}
            />
          )}
        </div>,
      );
    }
  }

  return (
    <div className={`gallery ${selecting ? "is-selecting" : ""}`}>
      <div ref={scroller} className="gallery-scroll" onScroll={onScroll}>
        <div ref={content} className="gallery-content" style={{ height: layout?.height ?? 0 }}>
          {items}
        </div>
        {layout && layout.order.length === 0 && <div className="empty">{emptyMessage}</div>}
      </div>

      {grouped && layout && layout.height > box.h && (
        <Scrubber
          layout={layout}
          height={box.h}
          scrollTop={scrollTop}
          onSeek={(y) => (scroller.current!.scrollTop = y)}
        />
      )}

      {selecting && !coverPicker && (
        <div className="selection-bar" role="toolbar" aria-label="Selection">
          <button className="btn btn-ghost" onClick={clear} aria-label="Clear selection" title="Clear selection (Esc)">
            ✕
          </button>
          <span className="selection-count">{nf.format(visibleSelection.length)} selected</span>
          <button
            className="btn btn-primary album-action"
            disabled={!visibleSelection.length || busy}
            onClick={() => onAddToAlbum(visibleSelection, clear)}
          >
            <Icon name="addAlbum" /> Add to album…
          </button>
          {visibility === "all" && publicIds.length > 0 && (
            <button className="btn album-action" disabled={busy} onClick={() => void changePrivacy(publicIds, true)}>
              <Icon name="lock" /> {privateIds.length ? `Make ${publicIds.length} private` : "Make private"}
            </button>
          )}
          {privateIds.length > 0 && (
            <button className="btn" disabled={busy} onClick={() => void changePrivacy(privateIds, false)}>
              {publicIds.length ? `Remove ${privateIds.length} from Private` : "Remove from Private"}
            </button>
          )}
          {onRemoveFromAlbum && (
            <button
              className="btn"
              disabled={!visibleSelection.length || busy}
              onClick={async () => {
                setBusy(true);
                setAlbumError("");
                try {
                  await onRemoveFromAlbum(visibleSelection);
                  clear();
                } catch (err) {
                  setAlbumError((err as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Remove from album
            </button>
          )}
          <button
            className="btn btn-primary"
            disabled={!visibleSelection.length || busy}
            onClick={() => setBulkOpen(true)}
          >
            Set location…
          </button>
          <button
            className="btn btn-primary"
            disabled={!visibleSelection.length || busy}
            onClick={() => setBulkDateOpen(true)}
          >
            Set date…
          </button>
          {manualIds.length > 0 && (
            <button
              className="btn"
              disabled={busy}
              onClick={resetSelected}
              title="Go back to the locations stored in the files"
            >
              Reset {manualIds.length < visibleSelection.length ? nf.format(manualIds.length) : ""} location
              {manualIds.length === 1 ? "" : "s"}
            </button>
          )}
          {manualDateIds.length > 0 && (
            <button
              className="btn"
              disabled={busy}
              onClick={resetSelectedDates}
              title="Go back to the dates stored in the files"
            >
              Reset {manualDateIds.length < visibleSelection.length ? nf.format(manualDateIds.length) : ""} date
              {manualDateIds.length === 1 ? "" : "s"}
            </button>
          )}
          {albumError && (
            <span className="error" role="alert">
              {albumError}
            </span>
          )}
        </div>
      )}

      {bulkDateOpen && (
        <BulkDateDialog
          points={points}
          ids={visibleSelection}
          indexOf={indexOf}
          onClose={() => setBulkDateOpen(false)}
          onDone={() => {
            setBulkDateOpen(false);
            clear();
            onLocationsChanged();
          }}
        />
      )}

      {bulkOpen && (
        <BulkLocationDialog
          points={points}
          ids={visibleSelection}
          indexOf={indexOf}
          onClose={() => setBulkOpen(false)}
          onDone={() => {
            setBulkOpen(false);
            clear();
            onLocationsChanged();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- scrubber

interface Mark {
  /** Position on the rail. */
  y: number;
  /** Content offset of the group it marks. */
  cy: number;
  label: string | null;
}

const SNAP_PX = 10;

/** Google-Photos-style date rail: years labelled, months as dots, drag to jump. */
function Scrubber({
  layout,
  height,
  scrollTop,
  onSeek,
}: {
  layout: Layout;
  height: number;
  scrollTop: number;
  onSeek(y: number): void;
}) {
  const rail = useRef<HTMLDivElement>(null);
  const [hoverY, setHoverY] = useState<number | null>(null);
  const dragging = useRef(false);
  const PAD_Y = 12;
  const track = Math.max(1, height - PAD_Y * 2);
  const toTrack = (cy: number) => PAD_Y + (cy / layout.height) * track;
  const toContent = (ty: number) => Math.min(layout.height, Math.max(0, ((ty - PAD_Y) / track) * layout.height));

  const marks = useMemo(() => {
    const out: Mark[] = [];
    let lastYear = "";
    let lastMonth = -1;
    let lastLabelY = -Infinity;
    let lastDotY = -Infinity;
    for (const g of layout.groups) {
      const ty = PAD_Y + (g.y / layout.height) * track;
      if (Number.isNaN(g.t)) {
        out.push({ y: ty, cy: g.y, label: "?" });
        continue;
      }
      const year = formatYear(g.t);
      const month = new Date(g.t * 1000).getUTCMonth();
      if (year !== lastYear) {
        lastYear = year;
        lastMonth = month;
        // Labels need room; a crowded year becomes a dot.
        if (ty - lastLabelY >= 18) {
          out.push({ y: ty, cy: g.y, label: year });
          lastLabelY = ty;
          lastDotY = ty;
          continue;
        }
      } else if (month === lastMonth) continue;
      lastMonth = month;
      if (ty - lastDotY >= 6 && ty - lastLabelY >= 10) {
        out.push({ y: ty, cy: g.y, label: null });
        lastDotY = ty;
      }
    }
    return out;
  }, [layout, track]);

  const localY = (e: React.PointerEvent) => e.clientY - rail.current!.getBoundingClientRect().top;
  // On or next to a year label means "that year": snap to its first day.
  const target = (ty: number) => {
    let best: Mark | null = null;
    for (const m of marks)
      if (m.label && Math.abs(m.y - ty) <= SNAP_PX && (!best || Math.abs(m.y - ty) < Math.abs(best.y - ty))) best = m;
    return best ? best.cy : toContent(ty);
  };
  const seek = (ty: number) => onSeek(target(ty));
  const hoverLabel = hoverY != null ? labelAt(layout, target(hoverY)) : null;

  return (
    <div
      ref={rail}
      className="scrubber"
      onPointerDown={(e) => {
        dragging.current = true;
        rail.current!.setPointerCapture(e.pointerId);
        seek(localY(e));
      }}
      onPointerMove={(e) => {
        const y = localY(e);
        setHoverY(y);
        if (dragging.current) seek(y);
      }}
      onPointerUp={(e) => {
        dragging.current = false;
        rail.current!.releasePointerCapture(e.pointerId);
      }}
      onPointerLeave={() => !dragging.current && setHoverY(null)}
    >
      {marks.map((m, i) =>
        m.label ? (
          <span key={i} className="scrubber-year" style={{ top: m.y }}>
            {m.label}
          </span>
        ) : (
          <span key={i} className="scrubber-dot" style={{ top: m.y }} />
        ),
      )}
      <span className="scrubber-thumb" style={{ top: toTrack(scrollTop) }} />
      {hoverY != null && hoverLabel && (
        <span className="scrubber-hover" style={{ top: Math.min(Math.max(hoverY, 14), height - 14) }}>
          {hoverLabel}
        </span>
      )}
    </div>
  );
}

function labelAt(layout: Layout, cy: number): string | null {
  if (!layout.groups.length) return null;
  const g = layout.groups[groupAt(layout.groups, cy)]!;
  return Number.isNaN(g.t) ? "No date" : formatMonth(g.t);
}
