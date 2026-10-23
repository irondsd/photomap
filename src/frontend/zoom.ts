import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type SyntheticEvent,
} from "react";

/** Pan (px, from the centred position) and scale of the photo, about the image centre. */
export interface View {
  s: number;
  x: number;
  y: number;
}
interface Pt {
  x: number;
  y: number;
}
export interface Size {
  w: number;
  h: number;
}

export const IDENTITY: View = { s: 1, x: 0, y: 0 };
const MIN_MAX_SCALE = 4;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Scale to `s` keeping the point `p` (relative to the stage centre) where it is on screen. */
export function zoomAt(v: View, s: number, p: Pt): View {
  const k = s / v.s;
  return { s, x: p.x - k * (p.x - v.x), y: p.y - k * (p.y - v.y) };
}

/** No panning past the image's edges, and none at all along a side that still fits the stage. */
export function clampPan(v: View, img: Size, stage: Size): View {
  const mx = Math.max(0, (img.w * v.s - stage.w) / 2);
  const my = Math.max(0, (img.h * v.s - stage.h) / 2);
  // `|| 0`: no -0 from clamping a negative pan into [-0, 0].
  return { s: v.s, x: clamp(v.x, -mx, mx) || 0, y: clamp(v.y, -my, my) || 0 };
}

/** Deep enough to see the original's pixels at 2×, and never less than 4×. */
export function maxScale(pixels: number | null, img: Size): number {
  const shown = Math.max(img.w, img.h);
  return pixels && shown ? Math.max(MIN_MAX_SCALE, (2 * pixels) / shown) : MIN_MAX_SCALE;
}

/**
 * The unzoomed size: fit inside the stage, never enlarged past the image's own pixels (the original's, once
 * known, so swapping the preview for the original doesn't resize it).
 */
export function fitSize(natural: Size, stage: Size, pixels: number | null): Size {
  const long = Math.max(natural.w, natural.h);
  const cap = Math.max(long, pixels ?? 0) / long;
  const k = Math.min(cap, stage.w / natural.w, stage.h / natural.h);
  return { w: natural.w * k, h: natural.h * k };
}

/**
 * Where the zoomed image goes: a real width and height plus a translation snapped to device pixels. A
 * `scale()` transform would make Chrome rasterize at a fractional scale, leaving hairline seams along its
 * tile edges.
 */
export function placement(v: View, base: Size, stage: Size, dpr: number) {
  const snap = (n: number) => Math.round(n * dpr) / dpr;
  const w = snap(base.w * v.s);
  const h = snap(base.h * v.s);
  return { w, h, left: snap((stage.w - w) / 2 + v.x), top: snap((stage.h - h) / 2 + v.y) };
}

const midpoint = (ps: Pt[]): Pt => ({
  x: ps.reduce((a, p) => a + p.x, 0) / ps.length,
  y: ps.reduce((a, p) => a + p.y, 0) / ps.length,
});
const spread = (ps: Pt[]) => (ps.length > 1 ? Math.hypot(ps[0]!.x - ps[1]!.x, ps[0]!.y - ps[1]!.y) : 0);

/**
 * Scroll, pinch (trackpad or touch), double-click and drag zoom for an image centred in `stage`.
 * `pixels` is the original's long side, for how far it may zoom; a new `photoKey` starts unzoomed.
 */
export function useZoom(
  stageRef: RefObject<HTMLElement | null>,
  imgRef: RefObject<HTMLImageElement | null>,
  pixels: number | null,
  enabled: boolean,
  photoKey: unknown,
) {
  const [view, setView] = useState<View>(IDENTITY);
  const [animate, setAnimate] = useState(false);
  const [panning, setPanning] = useState(false);
  /** The shown image's own size, once loaded, and the stage's: both needed to lay the image out. */
  const [natural, setNatural] = useState<Size | null>(null);
  const [stage, setStage] = useState<Size | null>(null);
  const viewRef = useRef(view);
  const baseRef = useRef<Size | null>(null);
  const stageSizeRef = useRef<Size | null>(null);
  const pixelsRef = useRef(pixels);
  pixelsRef.current = pixels;
  stageSizeRef.current = stage;
  const base = natural && stage ? fitSize(natural, stage, pixels) : null;
  baseRef.current = base;

  const apply = useCallback((next: (v: View, max: number) => View, anim = false) => {
    const b = baseRef.current;
    const st = stageSizeRef.current;
    if (!b || !st) return;
    const v = clampPan(next(viewRef.current, maxScale(pixelsRef.current, b)), b, st);
    viewRef.current = v;
    setAnimate(anim);
    setView(v);
  }, []);

  const zoomTo = useCallback(
    (s: number, p: Pt, anim = false) => apply((v, max) => zoomAt(v, clamp(s, 1, max), p), anim),
    [apply],
  );

  const reset = useCallback(() => {
    viewRef.current = IDENTITY;
    setAnimate(true);
    setView(IDENTITY);
  }, []);

  useEffect(() => {
    viewRef.current = IDENTITY;
    setAnimate(false);
    setView(IDENTITY);
    setNatural(null);
  }, [photoKey]);

  /** Client coordinates → relative to the stage centre, where the unpanned image centre sits. */
  const toStage = (clientX: number, clientY: number): Pt => {
    const r = stageRef.current!.getBoundingClientRect();
    return { x: clientX - r.left - r.width / 2, y: clientY - r.top - r.height / 2 };
  };

  // The image shrinks or grows with the window and the info panel.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStage({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the stage element lives as long as the viewer.
  }, []);
  // …and the pan has to stay inside it.
  useEffect(() => apply((v) => v), [apply, base?.w, base?.h, stage?.w, stage?.h]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el || !enabled) return;
    const onWheel = (e: WheelEvent) => {
      // Not over the top bar or the arrows.
      if ((e.target as Element).closest("button, a, .viewer-top")) return;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
      const dy = e.deltaY * unit;
      if (!dy) return;
      e.preventDefault();
      // Trackpad pinch arrives as Ctrl+wheel with small deltas: make it as fast as the fingers. Plain
      // scrolling zooms ~15% per mouse-wheel notch (~100px), eased so the steps don't jump.
      const step = e.ctrlKey ? clamp(dy, -25, 25) * 0.01 : clamp(dy, -100, 100) * 0.002;
      zoomTo(viewRef.current.s * 2 ** -step, toStage(e.clientX, e.clientY), !e.ctrlKey && Math.abs(dy) >= 50);
    };
    // Safari reports trackpad pinch as gesture events instead.
    let gestureStart = 1;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      gestureStart = viewRef.current.s;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as Event & { scale: number; clientX: number; clientY: number };
      zoomTo(gestureStart * g.scale, toStage(g.clientX, g.clientY));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the stage element lives as long as the viewer.
  }, [enabled, zoomTo]);

  // One pointer pans, two pinch; the gesture restarts whenever a finger is added or lifted.
  const pointers = useRef(new Map<number, Pt>());
  const gesture = useRef<{ view: View; mid: Pt; dist: number } | null>(null);
  /** The last press moved: it was a drag, not a click. */
  const moved = useRef(false);

  const startGesture = () => {
    const ps = [...pointers.current.values()];
    gesture.current = ps.length ? { view: viewRef.current, mid: midpoint(ps), dist: spread(ps) } : null;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (!enabled || (e.pointerType === "mouse" && e.button !== 0)) return;
    // Buttons and overlays on the stage keep their clicks.
    if (e.target !== e.currentTarget && e.target !== imgRef.current) return;
    if (pointers.current.size === 0) moved.current = false;
    pointers.current.set(e.pointerId, toStage(e.clientX, e.clientY));
    startGesture();
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const g = gesture.current;
    if (!g || !pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, toStage(e.clientX, e.clientY));
    const ps = [...pointers.current.values()];
    const mid = midpoint(ps);
    if (!moved.current) {
      if (ps.length < 2 && Math.hypot(mid.x - g.mid.x, mid.y - g.mid.y) < 4) return;
      // Capture only once it's a drag, so a plain click still lands on what was clicked.
      moved.current = true;
      for (const id of pointers.current.keys()) e.currentTarget.setPointerCapture(id);
      setPanning(true);
    }
    const dist = spread(ps);
    apply((_, max) => {
      const s = ps.length > 1 && g.dist > 0 ? clamp((g.view.s * dist) / g.dist, 1, max) : g.view.s;
      const z = zoomAt(g.view, s, g.mid);
      return { s, x: z.x + mid.x - g.mid.x, y: z.y + mid.y - g.mid.y };
    });
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    if (!pointers.current.delete(e.pointerId)) return;
    startGesture();
    if (pointers.current.size === 0) setPanning(false);
  };

  const onDoubleClick = (e: ReactMouseEvent<HTMLElement>) => {
    const b = baseRef.current;
    if (!enabled || !b || e.target !== imgRef.current) return;
    if (viewRef.current.s > 1) return reset();
    // Straight to the original's own pixels, or 2.5× if the screen already shows them all.
    const native = (pixelsRef.current ?? 0) / (Math.max(b.w, b.h) * devicePixelRatio);
    zoomTo(Math.max(2.5, native), toStage(e.clientX, e.clientY), true);
  };

  /** Zoom by a factor about the stage centre, for the keyboard. */
  const zoomBy = (k: number) => zoomTo(viewRef.current.s * k, { x: 0, y: 0 }, true);

  const onLoad = (e: SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    setNatural({ w: img.naturalWidth, h: img.naturalHeight });
  };

  // Until the image has loaded the stylesheet centres it.
  const p = base && stage && placement(view, base, stage, devicePixelRatio);
  const style: CSSProperties | undefined = p
    ? {
        position: "absolute",
        left: 0,
        top: 0,
        maxWidth: "none",
        maxHeight: "none",
        width: p.w,
        height: p.h,
        transform: `translate(${p.left}px, ${p.top}px)`,
      }
    : undefined;

  return {
    zoomed: view.s > 1,
    animate,
    panning,
    reset,
    zoomBy,
    /** True right after a drag, so the stage doesn't treat its end as a click on the backdrop. */
    wasDrag: () => moved.current,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onDoubleClick },
    /** For the zoomed `<img>`. */
    imgProps: { style, onLoad },
  };
}
