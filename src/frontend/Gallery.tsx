import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatMonth, formatYear, nf, SOURCE, type Points } from "./data";
import { buildLayout, firstVisible, galleryOrder, groupAt, HEADER_H, type Layout } from "./galleryLayout";
import { BulkLocationDialog } from "./BulkLocation";

// Room on the left for the day headers' select-all checks.
const LEFT = 44;
const SCRUBBER_W = 56;
const OVERSCAN = 800;

interface GalleryProps {
  points: Points;
  kinds: number;
  /** False while the gallery is hidden behind the map view. */
  active: boolean;
  /** Keyboard shortcuts pause while the viewer or a dialog is open. */
  paused: boolean;
  indexOf(id: number): number | undefined;
  onOpen(list: Int32Array, index: number): void;
  /** Locations were changed in bulk; reload the index. */
  onLocationsChanged(): void;
}

export function Gallery({ points, kinds, active, paused, indexOf, onOpen, onLocationsChanged }: GalleryProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  // Photo ids, so a selection survives the index being reloaded.
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const anchor = useRef<number | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useLayoutEffect(() => {
    const el = scroller.current!;
    const ro = new ResizeObserver(() => {
      // Hidden (display: none) reports 0; keep the last layout instead of collapsing it.
      if (el.clientWidth > 0) setBox({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const order = useMemo(() => galleryOrder(points, kinds), [points, kinds]);
  const contentW = Math.max(0, box.w - LEFT - SCRUBBER_W);
  const layout = useMemo(() => (contentW > 0 ? buildLayout(points, order, contentW, LEFT) : null), [points, order, contentW]);

  // Scroll position, at most once per frame.
  const frame = useRef(0);
  const saved = useRef(0);
  const onScroll = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const el = scroller.current!;
      if (el.clientHeight === 0) return; // hidden
      saved.current = el.scrollTop;
      setScrollTop(el.scrollTop);
    });
  };

  // Hiding the gallery (display: none) resets its scroll position; put it back when shown.
  useLayoutEffect(() => {
    if (active && scroller.current) scroller.current.scrollTop = saved.current;
  }, [active]);

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

  const onTileClick = (k: number, e: React.MouseEvent) => {
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

  useEffect(() => {
    if (!active || paused) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("input, textarea")) return;
      if (e.key === "Escape" && selected.size) {
        e.preventDefault();
        clear();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, paused, selected.size, clear]);

  const resetSelected = async () => {
    const n = manualIds.length;
    if (!confirm(`Undo the location you set on ${nf.format(n)} photo${n === 1 ? "" : "s"}?\n\nEach goes back to the location stored in its file, or to no location if the file has none.`)) return;
    setBusy(true);
    try {
      const r = await fetch("/api/locations/reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: manualIds }) });
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
        <div key={`g${g.start}`} className={`gheader ${all ? "is-selected" : ""}`} style={{ top: g.y, left: LEFT, width: contentW }}>
          <button className="gcheck" aria-pressed={all} aria-label={`Select all photos from ${g.label}`} onClick={() => toggleGroup(gi)} />
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
      items.push(
        <div
          key={id}
          className={`gtile ${sel ? "is-selected" : ""}`}
          style={{ left: layout.x[k], top: layout.y[k], width: layout.w[k], height: layout.h[k] }}
          onClick={(e) => onTileClick(k, e)}
        >
          <img src={`/thumbs/m/${id}`} alt="" loading="lazy" decoding="async" draggable={false} onLoad={(e) => e.currentTarget.classList.add("is-loaded")} />
          {points.kind[i] === 2 && <span className="gtile-video">▶</span>}
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
        </div>,
      );
    }
  }

  return (
    <div className={`gallery ${selecting ? "is-selecting" : ""}`}>
      <div ref={scroller} className="gallery-scroll" onScroll={onScroll}>
        <div className="gallery-content" style={{ height: layout?.height ?? 0 }}>
          {items}
        </div>
        {layout && layout.order.length === 0 && <div className="empty">No photos match this filter.</div>}
      </div>

      {layout && layout.height > box.h && (
        <Scrubber layout={layout} height={box.h} scrollTop={scrollTop} onSeek={(y) => (scroller.current!.scrollTop = y)} />
      )}

      {selecting && (
        <div className="selection-bar" role="toolbar" aria-label="Selection">
          <button className="btn btn-ghost" onClick={clear} aria-label="Clear selection" title="Clear selection (Esc)">
            ✕
          </button>
          <span className="selection-count">{nf.format(visibleSelection.length)} selected</span>
          <button className="btn btn-primary" disabled={!visibleSelection.length || busy} onClick={() => setBulkOpen(true)}>
            Set location…
          </button>
          {manualIds.length > 0 && (
            <button className="btn" disabled={busy} onClick={resetSelected} title="Go back to the locations stored in the files">
              Reset {manualIds.length < visibleSelection.length ? nf.format(manualIds.length) : ""}
            </button>
          )}
        </div>
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
function Scrubber({ layout, height, scrollTop, onSeek }: { layout: Layout; height: number; scrollTop: number; onSeek(y: number): void }) {
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
    for (const m of marks) if (m.label && Math.abs(m.y - ty) <= SNAP_PX && (!best || Math.abs(m.y - ty) < Math.abs(best.y - ty))) best = m;
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
