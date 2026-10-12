import { useLayoutEffect, useRef, useState } from "react";
import { formatDate, formatMonth, nf, type Points } from "./data";

export type SidebarTab = "map" | "noloc";

interface SidebarProps {
  points: Points;
  tab: SidebarTab;
  onTab(t: SidebarTab): void;
  onMap: Int32Array;
  noLocation: Int32Array;
  onOpen(list: Int32Array, index: number): void;
  onHover(i: number | null): void;
}

const TARGET_CELL = 112;
const GAP = 3;
const OVERSCAN_ROWS = 3;

function Grid({ points, list, onOpen, onHover, empty }: {
  points: Points;
  list: Int32Array;
  onOpen(list: Int32Array, index: number): void;
  onHover(i: number | null): void;
  empty: React.ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 300, h: 600 });
  const [scrollTop, setScrollTop] = useState(0);

  useLayoutEffect(() => {
    const el = scroller.current!;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // New result set: back to the top.
  useLayoutEffect(() => {
    scroller.current!.scrollTop = 0;
    setScrollTop(0);
  }, [list]);

  const cols = Math.max(2, Math.round(box.w / TARGET_CELL));
  const cell = (box.w - GAP * (cols - 1)) / cols;
  const rowH = cell + GAP;
  const rows = Math.ceil(list.length / cols);
  const first = Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN_ROWS);
  const last = Math.min(rows, Math.ceil((scrollTop + box.h) / rowH) + OVERSCAN_ROWS);

  const topIdx = list[Math.min(list.length - 1, Math.floor(scrollTop / rowH) * cols)];
  const topT = topIdx != null ? points.t[topIdx]! : NaN;

  const items: React.ReactNode[] = [];
  for (let r = first; r < last; r++) {
    for (let c = 0; c < cols; c++) {
      const k = r * cols + c;
      if (k >= list.length) break;
      const i = list[k]!;
      const t = points.t[i]!;
      items.push(
        <button
          key={i}
          className="cell"
          style={{ top: r * rowH, left: c * (cell + GAP), width: cell, height: cell }}
          onClick={() => onOpen(list, k)}
          onMouseEnter={() => onHover(i)}
          onMouseLeave={() => onHover(null)}
          title={Number.isNaN(t) ? "Unknown date" : formatDate(t)}
        >
          <img src={`/thumbs/s/${points.id[i]}`} alt="" loading="lazy" decoding="async" draggable={false} onError={(e) => e.currentTarget.classList.add("broken")} />
          {points.kind[i] === 2 && <span className="cell-video">▶</span>}
        </button>,
      );
    }
  }

  return (
    <div className="grid-wrap">
      {list.length > 0 && !Number.isNaN(topT) && <div className="grid-date">{formatMonth(topT)}</div>}
      <div ref={scroller} className="grid-scroll" onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
        {list.length === 0 ? (
          <div className="empty">{empty}</div>
        ) : (
          <div className="grid" style={{ height: rows * rowH }}>
            {items}
          </div>
        )}
      </div>
    </div>
  );
}

export function Sidebar(props: SidebarProps) {
  // Nothing to fix up → no tab. Falls back to the map list, and returns to the chosen
  // tab if the time range changes and untagged photos show up again.
  const hasNoLocation = props.noLocation.length > 0;
  const tab: SidebarTab = hasNoLocation ? props.tab : "map";
  const list = tab === "map" ? props.onMap : props.noLocation;
  return (
    <aside className="sidebar">
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "map"} className="tab" onClick={() => props.onTab("map")}>
          In this area <span className="count">{nf.format(props.onMap.length)}</span>
        </button>
        {hasNoLocation && (
          <button role="tab" aria-selected={tab === "noloc"} className="tab" onClick={() => props.onTab("noloc")}>
            No location <span className="count">{nf.format(props.noLocation.length)}</span>
          </button>
        )}
      </div>
      <Grid
        points={props.points}
        list={list}
        onOpen={props.onOpen}
        onHover={props.onHover}
        empty={tab === "map" ? "No geotagged photos here. Zoom out or widen the time range." : "Every photo in this range has a location."}
      />
    </aside>
  );
}
