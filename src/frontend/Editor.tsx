import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ASPECTS,
  aspectRatio,
  cropFits,
  fitCrop,
  frameSize,
  FULL,
  identity,
  MAX_ANGLE,
  noTweaks,
  presetCrop,
  sameEdits,
  TWEAK_MIN,
  turn,
  type Aspect,
  type Edits,
  type Rect,
  type TweakName,
} from "../edits/model";
import { applyTweaks, toneMaps, type ToneMaps } from "../edits/tweaks";

export interface EditablePhoto {
  id: number;
  name: string;
  edits: Edits | null;
}

export type EditResult = { kind: "saved"; detail: unknown } | { kind: "copied"; id: number; name: string } | null;

interface EditorProps {
  photo: EditablePhoto;
  /** null: discarded. */
  onDone(result: EditResult): void;
}

type Tab = "enhance" | "crop" | "tweaks";

const TWEAK_ROWS: { key: TweakName; label: string }[] = [
  { key: "hdr", label: "HDR effect" },
  { key: "brightness", label: "Brightness" },
  { key: "contrast", label: "Contrast" },
  { key: "highlights", label: "Highlights" },
  { key: "shadows", label: "Shadows" },
  { key: "blackPoint", label: "Black point" },
  { key: "saturation", label: "Saturation" },
  { key: "warmth", label: "Warmth" },
  { key: "tint", label: "Tint" },
  { key: "pop", label: "Pop" },
  { key: "vignette", label: "Vignette" },
];

/** Long side of the preview canvases; DRAFT while a slider is moving. */
const PREVIEW = 1600;
const DRAFT = 800;
/** How long after the last change the full-size preview is drawn. */
const SETTLE_MS = 160;
/** Smallest crop, as a share of the frame. */
const MIN_CROP = 0.04;
const PAD = 32;
/** Room under the photo for the straighten slider. */
const DIAL_H = 84;

type Handle = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

const rad = (d: number) => (d * Math.PI) / 180;
const lerp = (a: Rect, b: Rect, t: number): Rect => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  w: a.w + (b.w - a.w) * t,
  h: a.h + (b.h - a.h) * t,
});

/** The rect furthest along from `from` (which fits) toward `to` that still fits. */
function constrain(from: Rect, to: Rect, angle: number, aspect: number): Rect {
  if (cropFits(to, angle, aspect)) return to;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const m = (lo + hi) / 2;
    if (cropFits(lerp(from, to, m), angle, aspect)) lo = m;
    else hi = m;
  }
  return lerp(from, to, lo);
}

/** The crop after dragging handle `h` by (dx, dy), in frame units, before it's fitted to the photo. */
function dragged(r: Rect, h: Handle, dx: number, dy: number, k: number | null): Rect {
  if (h === "move")
    return { ...r, x: Math.min(1 - r.w, Math.max(0, r.x + dx)), y: Math.min(1 - r.h, Math.max(0, r.y + dy)) };
  let { x, y, w, h: hh } = r;
  const right = x + w;
  const bottom = y + hh;
  if (h.includes("w")) {
    x = Math.min(right - MIN_CROP, Math.max(0, x + dx));
    w = right - x;
  }
  if (h.includes("e")) w = Math.max(MIN_CROP, Math.min(1 - x, w + dx));
  if (h.includes("n")) {
    y = Math.min(bottom - MIN_CROP, Math.max(0, y + dy));
    hh = bottom - y;
  }
  if (h.includes("s")) hh = Math.max(MIN_CROP, Math.min(1 - y, hh + dy));
  if (k == null) return { x, y, w, h: hh };

  // Locked aspect (k = w/h in frame units).
  if (h.length === 2) {
    // Corners: scale by the mean of both changes, anchored at the opposite corner.
    let s = (w / r.w + hh / r.h) / 2;
    s = Math.max(s, MIN_CROP / Math.min(r.w, r.h));
    const nw = r.w * s;
    const nh = r.h * s;
    return {
      x: h.includes("w") ? right - nw : r.x,
      y: h.includes("n") ? bottom - nh : r.y,
      w: nw,
      h: nh,
    };
  }
  // Edges: the other side follows, about the middle.
  if (h === "e" || h === "w") {
    const nh = w / k;
    return { x, w, y: r.y + (r.h - nh) / 2, h: nh };
  }
  const nw = hh * k;
  return { y, h: hh, x: r.x + (r.w - nw) / 2, w: nw };
}

/** Fits a w×h box into an aw×ah area. */
function fit(w: number, h: number, aw: number, ah: number): [number, number] {
  const s = Math.min(aw / w, ah / h);
  return [Math.max(1, w * s), Math.max(1, h * s)];
}

/** Draws the turned, straightened and cropped photo, at most `max` on its long side. */
function drawGeometry(img: HTMLImageElement, e: Edits, max: number): ImageData {
  const sw = img.naturalWidth;
  const sh = img.naturalHeight;
  const [fw, fh] = frameSize(sw, sh, e.quarter);
  const cw = e.crop.w * fw;
  const ch = e.crop.h * fh;
  const s = Math.min(1, max / Math.max(cw, ch));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(cw * s));
  c.height = Math.max(1, Math.round(ch * s));
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = "high";
  ctx.scale(c.width / cw, c.height / ch);
  ctx.translate(-e.crop.x * fw, -e.crop.y * fh);
  ctx.translate(fw / 2, fh / 2);
  ctx.rotate(rad(e.quarter * 90 + e.angle));
  ctx.drawImage(img, -sw / 2, -sh / 2, sw, sh);
  return ctx.getImageData(0, 0, c.width, c.height);
}

function useBox(ref: React.RefObject<HTMLElement | null>) {
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(([en]) => setBox({ w: en!.contentRect.width, h: en!.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return box;
}

export function Editor({ photo, onDone }: EditorProps) {
  const initial = useMemo(() => photo.edits ?? identity(), [photo.edits]);
  const [edits, setEdits] = useState<Edits>(initial);
  /** The crop the person chose; straightening shrinks it to fit, and grows it back. */
  const baseCrop = useRef<Rect>(initial.crop);
  const [tab, setTab] = useState<Tab>("crop");
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState<"save" | "copy" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [compare, setCompare] = useState(false);
  const [dragging, setDragging] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const box = useBox(stageRef);
  const dirty = !sameEdits(edits, initial);

  useEffect(() => {
    const im = new Image();
    im.src = `/thumbs/l/${photo.id}?original`;
    im.decode().then(
      () => setImg(im),
      () => setLoadError(true),
    );
  }, [photo.id]);

  const [sw, sh] = img ? [img.naturalWidth, img.naturalHeight] : [3, 2];
  const [fw, fh] = frameSize(sw, sh, edits.quarter);
  const frameAspect = fw / fh;
  const ratio = aspectRatio(edits.aspect, edits.portrait);
  /** Locked crop shape in frame units. */
  const k = ratio == null ? null : ratio / frameAspect;

  // ---------------------------------------------------------------- crop tab: the whole frame, tweaked
  const cropCanvas = useRef<HTMLCanvasElement>(null);
  const tweakKey = JSON.stringify(compare ? noTweaks() : edits.tweaks);
  useEffect(() => {
    const c = cropCanvas.current;
    if (!img || !c || tab !== "crop") return;
    const s = Math.min(1, PREVIEW / Math.max(sw, sh));
    c.width = Math.round(sw * s);
    c.height = Math.round(sh * s);
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const t = JSON.parse(tweakKey);
    const d = ctx.getImageData(0, 0, c.width, c.height);
    applyTweaks(d.data, c.width, c.height, t, { vignette: false });
    ctx.putImageData(d, 0, 0);
  }, [img, tab, tweakKey, sw, sh]);

  // ---------------------------------------------------------------- tweaks tab: the final picture
  const outCanvas = useRef<HTMLCanvasElement>(null);
  /** The untweaked picture for the current geometry, at draft and full size; tone maps don't depend on size. */
  const geom = useRef<{ key: string; draft: ImageData; full: ImageData | null; maps: ToneMaps | null } | null>(null);
  const frame = useRef(0);
  const settle = useRef<ReturnType<typeof setTimeout>>(undefined);
  const geomKey = `${edits.quarter}|${edits.angle}|${edits.crop.x}|${edits.crop.y}|${edits.crop.w}|${edits.crop.h}`;
  useEffect(() => {
    if (!img || tab !== "tweaks") return;
    const draw = (full: boolean) => {
      const c = outCanvas.current;
      if (!c) return;
      if (geom.current?.key !== geomKey)
        geom.current = { key: geomKey, draft: drawGeometry(img, edits, DRAFT), full: null, maps: null };
      const g = geom.current;
      if (full) g.full ??= drawGeometry(img, edits, PREVIEW);
      const src = full ? g.full! : g.draft;
      const t = JSON.parse(tweakKey);
      if (!g.maps && (t.hdr || t.shadows || t.highlights || t.pop))
        g.maps = toneMaps(g.draft.data, g.draft.width, g.draft.height);
      const out = new ImageData(new Uint8ClampedArray(src.data), src.width, src.height);
      applyTweaks(out.data, out.width, out.height, t, { maps: g.maps ?? undefined });
      c.width = out.width;
      c.height = out.height;
      c.getContext("2d")!.putImageData(out, 0, 0);
    };
    // A quick draft while values change, the full preview once they stop.
    const first = geom.current?.key !== geomKey;
    cancelAnimationFrame(frame.current);
    clearTimeout(settle.current);
    frame.current = requestAnimationFrame(() => draw(first));
    if (!first) settle.current = setTimeout(() => draw(true), SETTLE_MS);
    return () => {
      cancelAnimationFrame(frame.current);
      clearTimeout(settle.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- geomKey stands for the geometry.
  }, [img, tab, tweakKey, geomKey]);

  // ---------------------------------------------------------------- layout
  const cropArea = { w: Math.max(1, box.w - 2 * PAD), h: Math.max(1, box.h - 2 * PAD - DIAL_H) };
  const [FW, FH] = fit(fw, fh, cropArea.w, cropArea.h);
  const [OW, OH] = fit(
    edits.crop.w * fw,
    edits.crop.h * fh,
    Math.max(1, box.w - 2 * PAD),
    Math.max(1, box.h - 2 * PAD),
  );
  // The unturned photo inside the frame, before CSS turns it.
  const [SW, SH] = edits.quarter % 2 ? [FH, FW] : [FW, FH];

  // ---------------------------------------------------------------- crop interactions
  const drag = useRef<{ handle: Handle; x: number; y: number; r0: Rect } | null>(null);
  const onHandleDown = (handle: Handle) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { handle, x: e.clientX, y: e.clientY, r0: edits.crop };
    setDragging(true);
  };
  const onHandleMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.x) / FW;
    const dy = (e.clientY - d.y) / FH;
    const to = dragged(d.r0, d.handle, dx, dy, k);
    let r: Rect;
    if (k != null) r = constrain(d.r0, to, edits.angle, frameAspect);
    else {
      // One axis at a time, so a crop stopped by one side still slides along it.
      const a = constrain(d.r0, { ...d.r0, x: to.x, w: to.w }, edits.angle, frameAspect);
      r = constrain(a, { ...a, y: to.y, h: to.h }, edits.angle, frameAspect);
    }
    setEdits((ed) => ({ ...ed, crop: r }));
  };
  const onHandleUp = () => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    baseCrop.current = edits.crop;
  };

  const setAngle = (a: number) => {
    const angle = Math.abs(a) < 0.3 ? 0 : a;
    setEdits((ed) => ({ ...ed, angle, crop: fitCrop(baseCrop.current, angle, frameAspect) }));
  };
  const quarterTurn = (dir: 1 | -1) => {
    setEdits((ed) => {
      const next = turn(ed, dir);
      baseCrop.current = turn({ ...ed, crop: baseCrop.current }, dir).crop;
      return next;
    });
  };
  const chooseAspect = (a: Aspect) => {
    setEdits((ed) => {
      // Choosing the selected preset again turns it between landscape and portrait.
      const portrait = a === ed.aspect && a !== "free" ? !ed.portrait : a === ed.aspect ? ed.portrait : fh > fw;
      const r = aspectRatio(a, portrait);
      if (r == null) return { ...ed, aspect: a };
      baseCrop.current = presetCrop(r, 0, frameAspect);
      return { ...ed, aspect: a, portrait, crop: fitCrop(baseCrop.current, ed.angle, frameAspect) };
    });
  };
  const resetCrop = () => {
    baseCrop.current = { ...FULL };
    setEdits((ed) => ({ ...ed, quarter: 0, angle: 0, crop: { ...FULL }, aspect: "free", portrait: false }));
  };
  const setTweak = (key: TweakName, v: number) => setEdits((ed) => ({ ...ed, tweaks: { ...ed.tweaks, [key]: v } }));

  // ---------------------------------------------------------------- leaving
  const discard = useCallback(() => {
    if (busy) return;
    if (dirty && !confirm("Discard your changes?\n\nThe photo stays as it was before you started editing.")) return;
    onDone(null);
  }, [busy, dirty, onDone]);

  const save = async () => {
    if (!dirty) return onDone(null);
    setBusy("save");
    setError(null);
    try {
      const r = await fetch(`/api/photos/${photo.id}/edits`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ edits }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Couldn't save the edits");
      onDone({ kind: "saved", detail: j });
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  };

  const saveCopy = async () => {
    setBusy("copy");
    setError(null);
    try {
      const r = await fetch(`/api/photos/${photo.id}/edits/copy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ edits }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Couldn't save the copy");
      onDone({ kind: "copied", id: j.id, name: j.name });
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("input[type=text], textarea")) return;
      if (e.key === "Escape") {
        e.preventDefault();
        discard();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [discard]);

  const changedTweaks = TWEAK_ROWS.some((r) => edits.tweaks[r.key] !== 0);
  const changedGeometry = edits.quarter !== 0 || edits.angle !== 0 || edits.crop.w < 0.9999 || edits.crop.h < 0.9999;

  return (
    <div className="viewer editor" role="dialog" aria-modal="true" aria-label={`Edit ${photo.name}`}>
      <div ref={stageRef} className={`editor-stage is-${tab}`}>
        {loadError ? (
          <div className="editor-msg">This photo can't be opened for editing.</div>
        ) : !img ? (
          <div className="editor-msg">Loading…</div>
        ) : tab === "tweaks" ? (
          <canvas ref={outCanvas} className="editor-out" style={{ width: OW, height: OH }} />
        ) : (
          <>
            <div
              className={`crop-frame ${dragging ? "is-dragging" : ""}`}
              style={{ width: FW, height: FH, marginBottom: DIAL_H }}
            >
              <canvas
                ref={cropCanvas}
                className="crop-photo"
                style={{
                  width: SW,
                  height: SH,
                  transform: `translate(-50%, -50%) rotate(${edits.quarter * 90 + edits.angle}deg)`,
                }}
              />
              <div
                className="crop-box"
                style={{
                  left: edits.crop.x * FW,
                  top: edits.crop.y * FH,
                  width: edits.crop.w * FW,
                  height: edits.crop.h * FH,
                }}
                onPointerDown={onHandleDown("move")}
                onPointerMove={onHandleMove}
                onPointerUp={onHandleUp}
                onPointerCancel={onHandleUp}
              >
                <div className="crop-grid" aria-hidden />
                {HANDLES.map((h) => (
                  <div
                    key={h}
                    className={`crop-handle crop-${h}`}
                    onPointerDown={onHandleDown(h)}
                    onPointerMove={onHandleMove}
                    onPointerUp={onHandleUp}
                    onPointerCancel={onHandleUp}
                  />
                ))}
              </div>
            </div>
            <div className="dial">
              <button className="btn btn-overlay dial-turn" onClick={() => quarterTurn(-1)} title="Rotate left 90°">
                <svg viewBox="0 0 24 24" aria-hidden>
                  <path d="M4 7v5h5" />
                  <path d="M5.5 15.5A7.5 7.5 0 1 0 6 8l-2 3" />
                </svg>
                <span className="sr-only">Rotate left</span>
              </button>
              <div className="dial-track">
                <div className="dial-value">
                  {edits.angle === 0 ? "0°" : `${edits.angle > 0 ? "+" : ""}${edits.angle.toFixed(1)}°`}
                </div>
                <input
                  type="range"
                  className="dial-range"
                  min={-MAX_ANGLE}
                  max={MAX_ANGLE}
                  step={0.1}
                  value={edits.angle}
                  aria-label="Straighten"
                  onChange={(e) => setAngle(Number(e.currentTarget.value))}
                  onPointerDown={() => setDragging(true)}
                  onPointerUp={() => setDragging(false)}
                  onDoubleClick={() => setAngle(0)}
                />
                <div className="dial-ticks" aria-hidden />
              </div>
              <button className="btn btn-overlay dial-turn" onClick={() => quarterTurn(1)} title="Rotate right 90°">
                <svg viewBox="0 0 24 24" aria-hidden>
                  <path d="M20 7v5h-5" />
                  <path d="M18.5 15.5A7.5 7.5 0 1 1 18 8l2 3" />
                </svg>
                <span className="sr-only">Rotate right</span>
              </button>
            </div>
          </>
        )}
        {img && (
          <button
            className="btn btn-overlay editor-compare"
            onPointerDown={() => setCompare(true)}
            onPointerUp={() => setCompare(false)}
            onPointerLeave={() => setCompare(false)}
            title="Hold to see the photo without tweaks"
          >
            Hold to compare
          </button>
        )}
      </div>

      <aside className="viewer-info editor-panel">
        <div className="tabs editor-tabs" role="tablist">
          <button role="tab" className="tab" aria-selected={false} disabled aria-describedby="enhance-soon">
            Enhance
            <span id="enhance-soon" className="sr-only">
              Coming soon
            </span>
          </button>
          <button role="tab" className="tab" aria-selected={tab === "crop"} onClick={() => setTab("crop")}>
            Crop
          </button>
          <button role="tab" className="tab" aria-selected={tab === "tweaks"} onClick={() => setTab("tweaks")}>
            Tweaks
          </button>
        </div>

        <div className="editor-tools">
          {tab === "crop" ? (
            <section>
              <h4>Aspect ratio</h4>
              <div className="aspects">
                {ASPECTS.map((a) => {
                  const on = edits.aspect === a;
                  const label = a === "free" ? "Free" : on && edits.portrait ? a.split(":").reverse().join(":") : a;
                  return (
                    <button
                      key={a}
                      className={`aspect ${on ? "is-on" : ""}`}
                      aria-pressed={on}
                      onClick={() => chooseAspect(a)}
                      title={on && a !== "free" ? "Click again to switch portrait / landscape" : undefined}
                    >
                      {a !== "free" && <AspectIcon a={a} portrait={on ? edits.portrait : false} />}
                      {label}
                    </button>
                  );
                })}
              </div>
              <p className="dim small">
                Drag the corners or edges to crop, the slider under the photo to straighten it.
              </p>
              <button className="btn btn-small" onClick={resetCrop} disabled={!changedGeometry}>
                Reset crop and rotation
              </button>
            </section>
          ) : (
            <section className="tweaks">
              {TWEAK_ROWS.map(({ key, label }) => (
                <TweakSlider
                  key={key}
                  label={label}
                  min={TWEAK_MIN[key] ?? -100}
                  value={edits.tweaks[key]}
                  onChange={(v) => setTweak(key, v)}
                />
              ))}
              <button
                className="btn btn-small"
                onClick={() => setEdits((ed) => ({ ...ed, tweaks: noTweaks() }))}
                disabled={!changedTweaks}
              >
                Reset tweaks
              </button>
            </section>
          )}
        </div>

        <div className="editor-exits">
          {error && <div className="error small">{error}</div>}
          <div className="row">
            <button className="btn" onClick={discard} disabled={!!busy} aria-keyshortcuts="Escape">
              {dirty ? "Discard" : "Cancel"}
            </button>
            <button className="btn" onClick={saveCopy} disabled={!!busy || !img || (!dirty && !photo.edits)}>
              {busy === "copy" ? "Saving copy…" : "Save as copy"}
            </button>
            <button className="btn btn-primary" onClick={save} disabled={!!busy || !img}>
              {busy === "save" ? "Saving…" : "Save"}
            </button>
          </div>
          <p className="dim small">
            Saving keeps your original file as it is. A copy is saved next to it as a new file.
          </p>
        </div>
      </aside>
    </div>
  );
}

function AspectIcon({ a, portrait }: { a: Aspect; portrait: boolean }) {
  const r = aspectRatio(a, portrait) ?? 1;
  const [w, h] = r >= 1 ? [16, 16 / r] : [16 * r, 16];
  return (
    <svg viewBox="0 0 20 20" className="aspect-icon" aria-hidden>
      <rect x={10 - w / 2} y={10 - h / 2} width={w} height={h} rx={1.5} />
    </svg>
  );
}

function TweakSlider({
  label,
  min,
  value,
  onChange,
}: {
  label: string;
  min: number;
  value: number;
  onChange(v: number): void;
}) {
  // The fill runs from zero, so a centred slider shows which way it was pushed.
  const zero = ((0 - min) / (100 - min)) * 100;
  const at = ((value - min) / (100 - min)) * 100;
  return (
    <label className="tweak" onDoubleClick={() => onChange(0)} title="Double-click to reset">
      <span className="tweak-label">
        <span className="tweak-name">
          {label}
          {value !== 0 && (
            <button
              type="button"
              className="tweak-reset"
              onClick={(e) => {
                e.preventDefault();
                onChange(0);
              }}
              aria-label={`Reset ${label}`}
              title={`Reset ${label}`}
            >
              <svg viewBox="0 0 12 12" aria-hidden>
                <path d="M3 3l6 6M9 3l-6 6" />
              </svg>
            </button>
          )}
        </span>
        <span className={`tweak-value ${value ? "is-set" : ""}`}>{value > 0 && min < 0 ? `+${value}` : value}</span>
      </span>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={100}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        style={{ "--from": `${Math.min(zero, at)}%`, "--to": `${Math.max(zero, at)}%` } as React.CSSProperties}
      />
    </label>
  );
}
