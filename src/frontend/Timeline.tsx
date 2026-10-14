import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  APPROX, addUnit, floorTo, lowerBound, nf, formatDate, formatDayShort, formatHour, formatMonth, formatMonthShort,
  formatRange, formatYear, type Points, type Range, type Unit,
} from "./data";

interface TimelineProps {
  points: Points;
  kinds: number;
  selection: Range | null;
  onSelect(r: Range | null): void;
  /** When set, only points with mask[i] = 1 are counted (photos in the map viewport). */
  mapMask: Uint8Array | null;
  followMap: boolean;
  onFollowMap(v: boolean): void;
  /** Time of the hovered photo, drawn as a marker. */
  hoverT: number | null;
  /** Only used to repaint the canvas with the new theme colors. */
  dark: boolean;
}

const AXIS_H = 22;
const TOP_PAD = 6;
const MIN_BAR_PX = 5;
const MIN_TICK_PX = 64;
const MIN_SPAN = 6 * 3600;
const EDGE_PX = 6;

const BIN_UNITS: [Unit, number][] = [
  ["hour", 1], ["hour", 3], ["hour", 6], ["day", 1], ["week", 1], ["month", 1], ["month", 3], ["year", 1],
];
const TICK_UNITS: [Unit, number][] = [
  ["hour", 1], ["hour", 3], ["hour", 6], ["hour", 12], ["day", 1], ["day", 2], ["week", 1],
  ["month", 1], ["month", 3], ["month", 6], ["year", 1], ["year", 2], ["year", 5], ["year", 10], ["year", 25], ["year", 50],
];

function pickUnit(span: number, width: number, units: [Unit, number][], minPx: number): [Unit, number] {
  for (const [u, s] of units) if ((APPROX[u] * s * width) / span >= minPx) return [u, s];
  return units[units.length - 1]!;
}

function stepEdge(t: number, unit: Unit, step: number) {
  return unit === "hour" ? t + step * 3600 : addUnit(t, unit, step);
}

interface Bins {
  edges: Float64Array;
  geo: Uint32Array;
  nogeo: Uint32Array;
  max: number;
  unit: Unit;
  step: number;
}

function computeBins(p: Points, view: Range, width: number, kinds: number, mask: Uint8Array | null): Bins {
  const span = view[1] - view[0];
  const [unit, step] = pickUnit(span, width, BIN_UNITS, MIN_BAR_PX);
  const edges: number[] = [];
  for (let e = floorTo(view[0], unit, step); e <= view[1]; e = stepEdge(e, unit, step)) edges.push(e);
  edges.push(stepEdge(edges[edges.length - 1]!, unit, step));
  const nb = edges.length - 1;
  const geo = new Uint32Array(nb);
  const nogeo = new Uint32Array(nb);
  let max = 0;
  let i = lowerBound(p.t, p.dated, edges[0]!);
  for (let b = 0; b < nb; b++) {
    const end = edges[b + 1]!;
    let g = 0;
    let ng = 0;
    for (; i < p.dated && p.t[i]! < end; i++) {
      if (!((1 << p.kind[i]!) & kinds)) continue;
      if (mask) {
        if (mask[i]) g++;
      } else if (Number.isNaN(p.lat[i]!)) ng++;
      else g++;
    }
    geo[b] = g;
    nogeo[b] = ng;
    if (g + ng > max) max = g + ng;
  }
  return { edges: Float64Array.from(edges), geo, nogeo, max, unit, step };
}

function binLabel(t: number, unit: Unit, step: number): string {
  switch (unit) {
    case "year":
      return formatYear(t);
    case "month":
      return step === 1 ? formatMonth(t) : `${formatMonthShort(t)}–${formatMonth(addUnit(t, "month", step - 1))}`;
    case "week":
      return `Week of ${formatDate(t)}`;
    case "day":
      return formatDate(t);
    case "hour":
      return `${formatDate(t)}, ${formatHour(t)}–${formatHour(t + step * 3600)}`;
  }
}

function tickLabel(t: number, unit: Unit): { text: string; major: boolean } {
  const d = new Date(t * 1000);
  switch (unit) {
    case "year":
      return { text: formatYear(t), major: true };
    case "month":
      return d.getUTCMonth() === 0 ? { text: formatYear(t), major: true } : { text: formatMonthShort(t), major: false };
    case "week":
    case "day":
      return d.getUTCDate() === 1 && d.getUTCMonth() === 0
        ? { text: formatYear(t), major: true }
        : { text: formatDayShort(t), major: d.getUTCDate() === 1 };
    case "hour":
      return d.getUTCHours() === 0 ? { text: formatDayShort(t), major: true } : { text: formatHour(t), major: false };
  }
}

function dataExtent(p: Points): Range {
  if (p.dated === 0) {
    const now = Date.now() / 1000;
    return [now - 365 * 86400, now];
  }
  const a = p.t[0]!;
  const b = p.t[p.dated - 1]!;
  const pad = Math.max((b - a) * 0.03, 86400);
  return [a - pad, b + pad];
}

type Drag =
  | { mode: "brush"; x0: number; t0: number; moved: boolean }
  | { mode: "move"; x0: number; sel: Range }
  | { mode: "resize"; edge: 0 | 1; sel: Range }
  | { mode: "pan"; x0: number; view: Range };

function cssVar(el: Element, name: string) {
  return getComputedStyle(el).getPropertyValue(name).trim();
}

export function Timeline(props: TimelineProps) {
  const { points, selection } = props;
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 800, h: 100 });
  const extent = useMemo(() => dataExtent(points), [points]);
  const [view, setView] = useState<Range>(extent);
  const [draft, setDraftState] = useState<Range | null>(null); // selection while dragging
  const draftRef = useRef<Range | null>(null);
  const setDraft = (r: Range | null) => {
    draftRef.current = r;
    setDraftState(r);
  };
  const [hoverX, setHoverX] = useState<number | null>(null);
  const drag = useRef<Drag | null>(null);
  const anim = useRef<number>(0);
  const lastCommit = useRef(0);

  useEffect(() => setView(extent), [extent]);

  useLayoutEffect(() => {
    const el = wrap.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const span = view[1] - view[0];
  const maxSpan = Math.max((extent[1] - extent[0]) * 1.5, 30 * 86400);
  const xOf = useCallback((t: number) => ((t - view[0]) / span) * size.w, [view, span, size.w]);
  const tOf = useCallback((x: number) => view[0] + (x / size.w) * span, [view, span, size.w]);

  const clampView = useCallback(
    (v: Range): Range => {
      const s = Math.min(Math.max(v[1] - v[0], MIN_SPAN), maxSpan);
      let a = v[0] + (v[1] - v[0] - s) / 2;
      const lo = extent[0] - s * 0.5;
      const hi = extent[1] + s * 0.5;
      a = Math.min(Math.max(a, lo), hi - s);
      return [a, a + s];
    },
    [extent, maxSpan],
  );

  const animateTo = useCallback(
    (target: Range) => {
      cancelAnimationFrame(anim.current);
      const from = view;
      const to = clampView(target);
      const start = performance.now();
      const tick = (now: number) => {
        const k = Math.min(1, (now - start) / 280);
        const e = 1 - Math.pow(1 - k, 3);
        setView([from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e]);
        if (k < 1) anim.current = requestAnimationFrame(tick);
      };
      anim.current = requestAnimationFrame(tick);
    },
    [view, clampView],
  );

  const bins = useMemo(
    () => computeBins(points, view, size.w, props.kinds, props.mapMask),
    [points, view, size.w, props.kinds, props.mapMask],
  );

  const shown = draft ?? selection;

  // ------------------------------------------------------------ drawing
  useEffect(() => {
    const c = canvas.current!;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(size.w * dpr);
    c.height = Math.round(size.h * dpr);
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);

    const accent = cssVar(c, "--accent");
    const muted = cssVar(c, "--bar-muted");
    const dim = cssVar(c, "--text-dim");
    const text = cssVar(c, "--text");
    const grid = cssVar(c, "--grid");
    const barsH = size.h - AXIS_H - TOP_PAD;
    const base = TOP_PAD + barsH;

    // Ticks and grid.
    const [tu, ts] = pickUnit(span, size.w, TICK_UNITS, MIN_TICK_PX);
    ctx.textBaseline = "middle";
    for (let t = floorTo(view[0], tu, ts); t <= view[1]; t = stepEdge(t, tu, ts)) {
      const x = Math.round(xOf(t)) + 0.5;
      if (x < -40) continue;
      const { text: label, major } = tickLabel(t, tu);
      ctx.fillStyle = grid;
      ctx.fillRect(x, TOP_PAD, 1, barsH);
      ctx.fillStyle = major ? text : dim;
      ctx.font = `${major ? 600 : 400} 11px system-ui, sans-serif`;
      ctx.fillText(label, x + 4, base + AXIS_H / 2);
    }

    // Bars (sqrt scale so quiet days stay visible next to big trips).
    const { edges, geo, nogeo, max } = bins;
    const scale = max ? barsH / Math.sqrt(max) : 0;
    const selA = shown?.[0] ?? -Infinity;
    const selB = shown?.[1] ?? Infinity;
    for (let b = 0; b < geo.length; b++) {
      const total = geo[b]! + nogeo[b]!;
      if (!total) continue;
      const x0 = xOf(edges[b]!);
      const x1 = xOf(edges[b + 1]!);
      if (x1 < 0 || x0 > size.w) continue;
      const w = Math.max(1, x1 - x0 - (x1 - x0 > 4 ? 1 : 0));
      const hTotal = Math.max(2, Math.sqrt(total) * scale);
      const hGeo = total ? (hTotal * geo[b]!) / total : 0;
      const inSel = edges[b + 1]! > selA && edges[b]! < selB;
      ctx.globalAlpha = inSel ? 1 : 0.28;
      ctx.fillStyle = muted;
      ctx.fillRect(x0, base - hTotal, w, hTotal - hGeo);
      ctx.fillStyle = accent;
      ctx.fillRect(x0, base - hGeo, w, hGeo);
    }
    ctx.globalAlpha = 1;

    // Selection.
    if (shown) {
      const a = xOf(shown[0]);
      const b = xOf(shown[1]);
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.1;
      ctx.fillRect(a, 0, b - a, base);
      ctx.globalAlpha = 1;
      ctx.fillRect(Math.round(a) - 1, 0, 2, base);
      ctx.fillRect(Math.round(b) - 1, 0, 2, base);
      for (const x of [a, b]) {
        ctx.beginPath();
        ctx.roundRect(x - 3, base / 2 - 10, 6, 20, 3);
        ctx.fill();
      }
    }

    // Hovered photo.
    if (props.hoverT != null) {
      const x = Math.round(xOf(props.hoverT)) + 0.5;
      ctx.strokeStyle = text;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, base);
      ctx.stroke();
    }

    // Cursor.
    if (hoverX != null && !drag.current) {
      ctx.fillStyle = text;
      ctx.globalAlpha = 0.35;
      ctx.fillRect(Math.round(hoverX), 0, 1, base);
      ctx.globalAlpha = 1;
    }
  }, [bins, size, view, span, shown, hoverX, props.hoverT, props.dark, xOf]);

  // ------------------------------------------------------------ interaction
  const binAt = useCallback(
    (x: number) => {
      const t = tOf(x);
      const { edges } = bins;
      let lo = 0;
      let hi = edges.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (edges[mid + 1]! <= t) lo = mid + 1;
        else hi = mid;
      }
      return lo < edges.length - 1 ? lo : -1;
    },
    [bins, tOf],
  );

  const snap = useCallback(
    (r: Range): Range => {
      const { unit, step } = bins;
      const a = floorTo(r[0], unit, step);
      let b = floorTo(r[1], unit, step);
      if (b < r[1]) b = stepEdge(b, unit, step);
      return [a, Math.max(b, stepEdge(a, unit, step))];
    },
    [bins],
  );

  const commit = (r: Range | null, final: boolean) => {
    const now = performance.now();
    if (final || now - lastCommit.current > 120) {
      lastCommit.current = now;
      props.onSelect(r);
    }
  };

  const localX = (e: { clientX: number }) => e.clientX - canvas.current!.getBoundingClientRect().left;

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const x = localX(e);
    const y = e.clientY - canvas.current!.getBoundingClientRect().top;
    cancelAnimationFrame(anim.current);
    canvas.current!.setPointerCapture(e.pointerId);
    if (y > size.h - AXIS_H) {
      drag.current = { mode: "pan", x0: x, view };
    } else if (selection && Math.abs(x - xOf(selection[0])) < EDGE_PX) {
      drag.current = { mode: "resize", edge: 0, sel: selection };
    } else if (selection && Math.abs(x - xOf(selection[1])) < EDGE_PX) {
      drag.current = { mode: "resize", edge: 1, sel: selection };
    } else if (selection && x > xOf(selection[0]) && x < xOf(selection[1])) {
      drag.current = { mode: "move", x0: x, sel: selection };
    } else {
      drag.current = { mode: "brush", x0: x, t0: tOf(x), moved: false };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const x = localX(e);
    const y = e.clientY - canvas.current!.getBoundingClientRect().top;
    setHoverX(x);
    const d = drag.current;
    const el = canvas.current!;
    if (!d) {
      const nearEdge = selection && (Math.abs(x - xOf(selection[0])) < EDGE_PX || Math.abs(x - xOf(selection[1])) < EDGE_PX);
      const inside = selection && x > xOf(selection[0]) && x < xOf(selection[1]);
      el.style.cursor = y > size.h - AXIS_H ? "grab" : nearEdge ? "ew-resize" : inside ? "move" : "crosshair";
      return;
    }
    const t = tOf(x);
    switch (d.mode) {
      case "pan": {
        const dt = ((d.x0 - x) / size.w) * (d.view[1] - d.view[0]);
        setView(clampView([d.view[0] + dt, d.view[1] + dt]));
        break;
      }
      case "brush": {
        if (!d.moved && Math.abs(x - d.x0) < 3) return;
        d.moved = true;
        const r: Range = [Math.min(d.t0, t), Math.max(d.t0, t)];
        setDraft(r);
        commit(r, false);
        break;
      }
      case "move": {
        const dt = ((x - d.x0) / size.w) * span;
        const r: Range = [d.sel[0] + dt, d.sel[1] + dt];
        setDraft(r);
        commit(r, false);
        break;
      }
      case "resize": {
        const other = d.sel[d.edge === 0 ? 1 : 0];
        const r: Range = [Math.min(other, t), Math.max(other, t)];
        setDraft(r);
        commit(r, false);
        break;
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    canvas.current!.releasePointerCapture(e.pointerId);
    const x = localX(e);
    if (d.mode === "brush" && !d.moved) {
      // Click: select the bar under the cursor, or clear.
      const b = binAt(x);
      const has = b >= 0 && bins.geo[b]! + bins.nogeo[b]! > 0;
      if (has) {
        const r: Range = [bins.edges[b]!, bins.edges[b + 1]!];
        const same = selection && selection[0] === r[0] && selection[1] === r[1];
        commit(same ? null : r, true);
      } else {
        commit(null, true);
      }
    } else if (d.mode !== "pan" && draftRef.current) {
      const r = d.mode === "move" ? draftRef.current : snap(draftRef.current);
      commit(r, true);
    }
    setDraft(null);
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const b = binAt(localX(e));
    if (b < 0) return;
    const a = bins.edges[b]!;
    const z = bins.edges[b + 1]!;
    const pad = (z - a) * 0.15;
    animateTo([a - pad, z + pad]);
  };

  // Wheel needs a non-passive listener to stop page scroll / browser zoom.
  useEffect(() => {
    const el = canvas.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      cancelAnimationFrame(anim.current);
      const x = e.clientX - el.getBoundingClientRect().left;
      setView((v) => {
        const s = v[1] - v[0];
        if (!e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
          const dt = (e.deltaX / size.w) * s;
          return clampView([v[0] + dt, v[1] + dt]);
        }
        const factor = Math.exp(e.deltaY * (e.ctrlKey ? 0.012 : 0.0025));
        const ns = Math.min(Math.max(s * factor, MIN_SPAN), maxSpan);
        const tc = v[0] + (x / size.w) * s;
        const a = tc - ((tc - v[0]) * ns) / s;
        return clampView([a, a + ns]);
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [size.w, clampView, maxSpan]);

  // ------------------------------------------------------------ chrome
  const selCount = useMemo(() => {
    if (!shown) return null;
    let n = 0;
    const lo = lowerBound(points.t, points.dated, shown[0]);
    const hi = lowerBound(points.t, points.dated, shown[1]);
    for (let i = lo; i < hi; i++) if ((1 << points.kind[i]!) & props.kinds && (!props.mapMask || props.mapMask[i])) n++;
    return n;
  }, [shown, points, props.kinds, props.mapMask]);

  const hoverInfo = useMemo(() => {
    if (hoverX == null || drag.current) return null;
    const b = binAt(hoverX);
    if (b < 0) return null;
    const g = bins.geo[b]!;
    const ng = bins.nogeo[b]!;
    return { label: binLabel(bins.edges[b]!, bins.unit, bins.step), g, ng };
  }, [hoverX, bins, binAt]);

  const isFit = Math.abs(view[0] - extent[0]) < span * 0.01 && Math.abs(view[1] - extent[1]) < span * 0.01;

  return (
    <div className="timeline">
      <div className="timeline-bar">
        <div className="timeline-label">
          {shown ? (
            <>
              <strong>{formatRange(shown)}</strong>
              <span className="dim"> · {nf.format(selCount ?? 0)} {props.followMap ? "in map area" : "photos"}</span>
            </>
          ) : (
            <span className="dim">Drag to select a time range · scroll to zoom · drag the axis to pan</span>
          )}
        </div>
        <div className="timeline-actions">
          <label className="check" title="Count only photos inside the visible map area">
            <input type="checkbox" checked={props.followMap} onChange={(e) => props.onFollowMap(e.target.checked)} />
            Map area only
          </label>
          {selection && (
            <button className="btn btn-ghost" onClick={() => animateTo([selection[0] - (selection[1] - selection[0]) * 0.1, selection[1] + (selection[1] - selection[0]) * 0.1])}>
              Zoom to selection
            </button>
          )}
          {!isFit && (
            <button className="btn btn-ghost" onClick={() => animateTo(extent)}>
              All time
            </button>
          )}
          {selection && (
            <button className="btn btn-ghost" onClick={() => props.onSelect(null)} title="Clear selection (Esc)">
              Clear
            </button>
          )}
        </div>
      </div>
      <div ref={wrap} className="timeline-canvas-wrap">
        <canvas
          ref={canvas}
          style={{ width: size.w, height: size.h }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={() => setHoverX(null)}
          onDoubleClick={onDoubleClick}
        />
        {hoverInfo && hoverX != null && (
          <div className="timeline-tip" style={{ left: Math.min(Math.max(hoverX, 80), size.w - 80) }}>
            <div>{hoverInfo.label}</div>
            <div className="dim">
              {props.mapMask ? (
                <>{nf.format(hoverInfo.g)} in map area</>
              ) : (
                <>
                  {nf.format(hoverInfo.g + hoverInfo.ng)} photos
                  {hoverInfo.ng > 0 && <> · {nf.format(hoverInfo.ng)} without location</>}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
