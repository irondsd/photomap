import { useEffect, useMemo, useRef, useState } from "react";
import {
  formatBytes,
  formatDate,
  formatDateTime,
  formatExposure,
  formatOffset,
  formatYear,
  localStorageGet,
  localStorageSet,
  nearestTagged,
  nf,
  bumpThumb,
  thumbStamp,
  thumbUrl,
  type Points,
} from "./data";
import { Editor, type EditResult } from "./Editor";
import { editedSize, type Edits } from "../edits/model";
import { DatePicker, toDateInput, type DateInput } from "./DatePicker";
import { LocationPicker } from "./LocationPicker";
import { MiniMap } from "./MiniMap";
import type { LatLon } from "./coords";
import { useZoom } from "./zoom";
import { useBackToClose } from "./history";

interface PhotoDetail {
  id: number;
  path: string;
  name: string;
  rel_dir: string;
  kind: "photo" | "raw" | "video";
  size: number;
  taken_local: number | null;
  tz_offset: number | null;
  time_source: string | null;
  gps_source: string | null;
  lat: number | null;
  lon: number | null;
  alt: number | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  camera: string | null;
  lens: string | null;
  iso: number | null;
  fnumber: number | null;
  exposure: number | null;
  focal: number | null;
  country: string | null;
  /** Saved in Photomap; the file itself is unchanged. */
  edits: Edits | null;
  /** The edits can be written into the file (JPEG, PNG, WebP, TIFF). */
  writable: boolean;
}

interface ViewerProps {
  points: Points;
  /** Photo ids, not point indices: the points array is reloaded (and reordered) when the index changes. */
  ids: Uint32Array;
  index: number;
  /** Point index of a photo id in the current `points`. */
  indexOf(id: number): number | undefined;
  onIndex(i: number): void;
  onClose(): void;
  onShowOnMap(i: number): void;
  /** The photo's location, date or edits were changed; the caller should reload the index. */
  onLocationChange(): void;
  /** The photo was moved to the Trash and is gone from the index. */
  onDeleted(id: number): void;
}

async function sendEdits(url: string, method: string): Promise<PhotoDetail> {
  const r = await fetch(url, { method });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? "Something went wrong");
  return j;
}

const GPS_SOURCE_NOTE: Record<string, string> = {
  "inferred:burst": "Estimated: a photo with GPS was taken within minutes",
  "inferred:stay": "Estimated: photos before and after were taken at this spot",
  "inferred:home": "Estimated: probably home — photos before and after were taken here",
  "inferred:nearby": "Rough estimate: a photo with GPS was taken nearby within the hour",
  "inferred:series": "Estimated from the photos with GPS before and after this series",
};

const TIME_SOURCE_NOTE: Record<string, string> = {
  filename: "Date guessed from the file name",
  "filename-utc": "Date taken from the timestamp in the file name",
  gps: "Date from the GPS clock (the camera recorded none)",
  "gps-date": "Only the day is known, from the GPS data",
  original: "Date copied from the original of this edited copy",
  sequence: "Estimated from the photos numbered before and after it",
  edited: "Estimated from when it was edited — the photo was taken on or shortly before this day",
  folder: "Only the year is known, from the folder name",
  mtime: "Date taken from the file's modified time — may be wrong",
  exif: "Time zone unknown",
  "video-local": "Camera clock (GoPro); time zone from the location",
};

const DAY_ONLY = new Set(["gps-date", "edited", "manual-date"]);
const MANUAL_DATE = new Set(["manual", "manual-date"]);

/** Only as precise as the source allows: a year from a folder name isn't "1 Jan, 00:00". */
function formatTaken(t: number, source: string | null): string {
  if (source === "folder") return formatYear(t);
  if (source && DAY_ONLY.has(source)) return formatDate(t);
  return formatDateTime(t);
}

/** What the date fields start with: as much as is known, nothing for a guess from the file's modified time. */
function dateInputOf(d: PhotoDetail): DateInput | null {
  if (d.taken_local == null || d.time_source == null || d.time_source === "mtime" || d.time_source === "folder")
    return null;
  return toDateInput(d.taken_local, !DAY_ONLY.has(d.time_source));
}

async function sendDate(id: number, v: DateInput | null): Promise<PhotoDetail> {
  const r = await fetch(`/api/photos/${id}/date`, {
    method: v ? "POST" : "DELETE",
    headers: v ? { "content-type": "application/json" } : undefined,
    body: v ? JSON.stringify({ date: v.date, time: v.time || null }) : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? "Couldn't save the date");
  return j;
}

async function sendLocation(id: number, c: LatLon | null): Promise<PhotoDetail> {
  const r = await fetch(`/api/photos/${id}/location`, {
    method: c ? "POST" : "DELETE",
    headers: c ? { "content-type": "application/json" } : undefined,
    body: c ? JSON.stringify(c) : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? "Couldn't save the location");
  return j;
}

function formatDuration(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s % 60)).padStart(2, "0")}`;
}

export function Viewer({
  points,
  ids,
  index,
  indexOf,
  onIndex,
  onClose,
  onShowOnMap,
  onLocationChange,
  onDeleted,
}: ViewerProps) {
  useBackToClose(onClose);
  const id = ids[index]!;
  const i = indexOf(id);
  const isVideo = i != null && points.kind[i] === 2;
  const [detail, setDetail] = useState<PhotoDetail | null>(null);
  /** The photo whose large image has loaded. Keyed by id, not reset in an effect: after a wheel event React runs
   * effects only after paint, and a cached neighbour can finish loading before a reset would land. */
  const [loadedId, setLoadedId] = useState<number | null>(null);
  const loaded = loadedId === id;
  const [showInfo, setShowInfo] = useState(() => localStorageGet("pm.info") !== "0");
  const [editing, setEditing] = useState(false);
  const [editingDate, setEditingDate] = useState(false);
  /** The photo editor is open. */
  const [editingPhoto, setEditingPhoto] = useState(false);
  const [menu, setMenu] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const hint = useMemo(() => (editing && i != null ? nearestTagged(points, i) : null), [editing, points, i]);
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const d = detail?.id === id ? detail : null;
  const shown = d?.width && d.height ? (d.edits ? editedSize(d.width, d.height, d.edits) : [d.width, d.height]) : null;
  const pixels = d?.kind === "photo" && shown ? Math.max(...shown) : null;
  const stamp = thumbStamp(id);
  const zoom = useZoom(stageRef, imgRef, pixels, !isVideo, id);
  /** Photo id whose original has been decoded and replaces the 2048px preview. */
  const [fullId, setFullId] = useState<number | null>(null);
  const fullRequested = useRef<string | null>(null);

  useEffect(() => {
    setEditing(false);
    setEditingDate(false);
    setEditingPhoto(false);
    setMenu(false);
    setNotice(null);
    const ac = new AbortController();
    fetch(`/api/photos/${id}`, { signal: ac.signal })
      .then((r) => r.json())
      .then(setDetail)
      .catch(() => {});
    // Warm the neighbours.
    for (const k of [index + 1, index - 1]) {
      const nid = ids[k];
      const j = nid != null ? indexOf(nid) : undefined;
      if (j != null && points.kind[j] !== 2) new Image().src = thumbUrl(nid!, "l");
    }
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per photo, not when the list around it changes.
  }, [id]);

  // Zoomed in, the preview runs out of pixels: swap in the original if the browser can show it (not RAW;
  // HEIC only in Safari — a failed decode just keeps the preview).
  // An edited photo zooms into a full-size render of its edits instead.
  const wantFull = zoom.zoomed && d?.kind === "photo";
  const fullSrc = d?.edits ? `/edited/${id}?v=${stamp}` : `/original/${id}`;
  useEffect(() => {
    if (!wantFull || fullRequested.current === fullSrc) return;
    fullRequested.current = fullSrc;
    const im = new Image();
    im.src = fullSrc;
    im.decode().then(
      () => setFullId(id),
      () => {},
    );
  }, [wantFull, id, fullSrc]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The editor has keys of its own.
      if (editingPhoto) return;
      // Typing coordinates must not flip photos or close the viewer.
      if ((e.target as HTMLElement)?.closest?.("input, textarea")) return;
      if (e.key === "Escape" && menu) setMenu(false);
      else if (e.key === "Escape" && zoom.zoomed) zoom.reset();
      else if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" && index < ids.length - 1) onIndex(index + 1);
      else if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
      else if (e.key === "i") toggleInfo();
      else if (e.key === "e" && d && !isVideo) setEditingPhoto(true);
      else if (!isVideo && (e.key === "+" || e.key === "=")) zoom.zoomBy(2);
      else if (!isVideo && e.key === "-") zoom.zoomBy(0.5);
      else if (!isVideo && e.key === "0") zoom.reset();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // A horizontal wheel (or sideways swipe) flips photos, one per flick: the travel adds up to a notch's
  // worth before it steps, then the rest of that flick is ignored until the wheel pauses — or, if it keeps
  // turning, for a moment, so a long steady turn walks through photos at a calm pace instead of racing.
  const wheelNav = useRef({ acc: 0, lockedUntil: 0, lastEvent: 0 });
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientWidth : 1;
      const dx = e.deltaX * unit;
      if (!dx || Math.abs(dx) <= Math.abs(e.deltaY * unit)) return;
      // Keep the browser's swipe-to-go-back from firing.
      e.preventDefault();
      if (editingPhoto || zoom.zoomed) return;
      const s = wheelNav.current;
      const now = e.timeStamp;
      const quiet = now - s.lastEvent > 180;
      s.lastEvent = now;
      if (quiet) s.lockedUntil = 0;
      if (now < s.lockedUntil) return;
      if (quiet || Math.sign(dx) !== Math.sign(s.acc)) s.acc = 0;
      s.acc += dx;
      if (Math.abs(s.acc) < 40) return;
      const next = index + Math.sign(s.acc);
      s.acc = 0;
      s.lockedUntil = now + 450;
      if (next >= 0 && next < ids.length) onIndex(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  const toggleInfo = () =>
    setShowInfo((v) => {
      localStorageSet("pm.info", v ? "0" : "1");
      return !v;
    });

  const saveLocation = async (c: LatLon | null) => {
    const updated = await sendLocation(id, c);
    setDetail(updated);
    setEditing(false);
    onLocationChange();
  };
  const resetLocation = () => {
    const ok = confirm(
      "Undo the location you set?\n\nThe photo goes back to the location stored in its file, or to no location if the file has none.",
    );
    if (ok) saveLocation(null).catch((err) => alert(err.message));
  };
  const saveDate = async (v: DateInput | null) => {
    const updated = await sendDate(id, v);
    setDetail(updated);
    setEditingDate(false);
    onLocationChange();
  };
  const resetDate = () => {
    const ok = confirm(
      "Undo the date you set?\n\nThe photo goes back to the date stored in its file, or worked out from the files around it.",
    );
    if (ok) saveDate(null).catch((err) => alert(err.message));
  };
  // The menu closes on a click anywhere else.
  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => {
      if (!(e.target as Element).closest?.(".menu-wrap")) setMenu(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);

  /** The edits changed: images on the page load again, and the index (aspect ratios) too. */
  const editsChanged = (updated: PhotoDetail | null) => {
    if (updated) setDetail(updated);
    bumpThumb(id);
    setFullId(null);
    fullRequested.current = null;
    zoom.reset();
    onLocationChange();
  };
  const finishEditing = (r: EditResult) => {
    setEditingPhoto(false);
    if (!r) return;
    if (r.kind === "saved") {
      editsChanged(r.detail as PhotoDetail);
      setNotice("Edits saved. The original file is unchanged.");
    } else {
      onLocationChange();
      setNotice(`Saved a copy as ${r.name}.`);
    }
  };
  const revertEdits = async () => {
    setMenu(false);
    if (!confirm("Revert to the original?\n\nYour edits to this photo are removed. The file was never changed."))
      return;
    setWorking(true);
    try {
      editsChanged(await sendEdits(`/api/photos/${id}/edits`, "DELETE"));
      setNotice("Reverted to the original.");
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setWorking(false);
    }
  };
  const writeEdits = async () => {
    setMenu(false);
    if (
      !d ||
      !confirm(
        `Write the edits into ${d.name}?\n\nThe file is replaced with the edited version and its original pixels are gone for good. This can't be undone.`,
      )
    )
      return;
    setWorking(true);
    try {
      editsChanged(await sendEdits(`/api/photos/${id}/edits/apply`, "POST"));
      setNotice(`Edits written into ${d.name}.`);
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setWorking(false);
    }
  };

  const deletePhoto = async () => {
    if (
      !d ||
      !confirm(
        `Move ${d.name} to the Trash?\n\nIt's removed from Photomap too, along with its edits and any date or location you set here.`,
      )
    )
      return;
    setWorking(true);
    try {
      const r = await fetch(`/api/photos/${id}`, { method: "DELETE" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Couldn't delete the photo");
      onDeleted(id);
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setWorking(false);
    }
  };

  const settings =
    d &&
    [
      d.fnumber && `ƒ/${+d.fnumber.toFixed(1)}`,
      formatExposure(d.exposure),
      d.iso && `ISO ${d.iso}`,
      d.focal && `${+d.focal.toFixed(1)} mm`,
    ].filter(Boolean);

  return (
    <div className="viewer" role="dialog" aria-modal="true">
      <div
        ref={stageRef}
        className={`viewer-stage ${isVideo ? "" : "is-zoomable"} ${zoom.zoomed ? "is-zoomed" : ""} ${zoom.panning ? "is-panning" : ""}`}
        onClick={(e) => e.target === e.currentTarget && !zoom.wasDrag() && onClose()}
        {...zoom.handlers}
      >
        {isVideo ? (
          <video
            key={id}
            src={`/original/${id}`}
            poster={thumbUrl(id, "l")}
            controls
            autoPlay
            playsInline
            className="viewer-media"
          />
        ) : (
          <>
            <img
              key={`s${id}`}
              src={thumbUrl(id, "s")}
              alt=""
              className="viewer-media viewer-placeholder"
              aria-hidden
            />
            <img
              key={`l${id}`}
              ref={imgRef}
              src={fullId === id ? fullSrc : thumbUrl(id, "l")}
              alt={d?.name ?? ""}
              className={`viewer-media ${loaded ? "is-loaded" : ""} ${zoom.animate ? "is-animating" : ""}`}
              style={zoom.imgProps.style}
              draggable={false}
              onLoad={(e) => {
                setLoadedId(id);
                zoom.imgProps.onLoad(e);
              }}
            />
          </>
        )}
        <div className="viewer-top">
          <span className="viewer-pos">
            {nf.format(index + 1)} / {nf.format(ids.length)}
          </span>
          <div className="viewer-top-actions">
            {d && d.kind !== "video" && (
              <button
                className="btn btn-overlay"
                onClick={() => setEditingPhoto(true)}
                disabled={working}
                title="Edit (e)"
              >
                Edit
              </button>
            )}
            {d?.edits && (
              <div className="menu-wrap">
                <button
                  className="btn btn-overlay"
                  onClick={() => setMenu((m) => !m)}
                  aria-haspopup="menu"
                  aria-expanded={menu}
                  aria-label="More"
                  title="More"
                  disabled={working}
                >
                  {working ? "…" : "⋯"}
                </button>
                {menu && (
                  <div className="menu" role="menu">
                    <button role="menuitem" onClick={revertEdits}>
                      Revert to original
                    </button>
                    <button
                      role="menuitem"
                      onClick={writeEdits}
                      disabled={!d.writable}
                      title={
                        d.writable
                          ? undefined
                          : "Only JPEG, PNG, WebP and TIFF files can be rewritten. Save a copy instead."
                      }
                    >
                      Write edits into file…
                    </button>
                  </div>
                )}
              </div>
            )}
            <button className="btn btn-overlay" onClick={toggleInfo} title="Info (i)">
              Info
            </button>
            <button className="btn btn-overlay" onClick={onClose} title="Close (Esc)" aria-label="Close">
              ✕
            </button>
          </div>
        </div>
        {notice && (
          <div className="viewer-notice" role="status" onAnimationEnd={() => setNotice(null)} key={notice}>
            {notice}
          </div>
        )}
        {index > 0 && (
          <button className="viewer-nav viewer-prev" onClick={() => onIndex(index - 1)} aria-label="Previous">
            ‹
          </button>
        )}
        {index < ids.length - 1 && (
          <button className="viewer-nav viewer-next" onClick={() => onIndex(index + 1)} aria-label="Next">
            ›
          </button>
        )}
      </div>

      {showInfo && (
        <aside className={`viewer-info ${editing ? "is-editing" : ""}`}>
          {!d ? (
            <div className="dim">Loading…</div>
          ) : (
            <>
              {editingDate ? (
                <section>
                  <h4>{dateInputOf(d) ? "Change date" : "Add date"}</h4>
                  <DatePicker
                    initial={dateInputOf(d)}
                    hint={
                      d.time_source === "folder" && d.taken_local != null
                        ? `The folder name says ${formatYear(d.taken_local)}.`
                        : null
                    }
                    onSave={saveDate}
                    onCancel={() => setEditingDate(false)}
                  />
                </section>
              ) : (
                <section>
                  <h3>{d.taken_local != null ? formatTaken(d.taken_local, d.time_source) : "Unknown date"}</h3>
                  <div className="dim">
                    {formatOffset(d.tz_offset)}
                    {d.time_source && MANUAL_DATE.has(d.time_source) && <div className="small">Set by you</div>}
                    {d.time_source && TIME_SOURCE_NOTE[d.time_source] && (
                      <div className="note">{TIME_SOURCE_NOTE[d.time_source]}</div>
                    )}
                  </div>
                  <div className="row">
                    <button className="btn btn-small" onClick={() => setEditingDate(true)}>
                      {dateInputOf(d) ? "Change date" : "Add date"}
                    </button>
                    {d.time_source && MANUAL_DATE.has(d.time_source) && (
                      <button
                        className="btn btn-small"
                        onClick={resetDate}
                        title="Go back to the date stored in the file"
                      >
                        Reset
                      </button>
                    )}
                  </div>
                </section>
              )}

              {editing ? (
                <section>
                  <h4>{d.lat != null ? "Change location" : "Add location"}</h4>
                  <LocationPicker
                    initial={d.lat != null && d.lon != null ? { lat: d.lat, lon: d.lon } : null}
                    hint={hint}
                    onSave={saveLocation}
                    onCancel={() => setEditing(false)}
                  />
                </section>
              ) : d.lat != null && d.lon != null ? (
                <section>
                  <h4>Location</h4>
                  <MiniMap lat={d.lat} lon={d.lon} />
                  <div>{d.country ?? "Unknown country"}</div>
                  {d.gps_source === "manual" && <div className="dim small">Set by you</div>}
                  {d.gps_source && GPS_SOURCE_NOTE[d.gps_source] && (
                    <div className="note">{GPS_SOURCE_NOTE[d.gps_source]}</div>
                  )}
                  <div className="dim mono">
                    {d.lat.toFixed(5)}, {d.lon.toFixed(5)}
                    {d.alt != null && ` · ${Math.round(d.alt)} m`}
                  </div>
                  <div className="row">
                    {i != null && (
                      <button className="btn btn-small" onClick={() => onShowOnMap(i)}>
                        Show on map
                      </button>
                    )}
                    <a
                      className="btn btn-small"
                      href={`https://www.google.com/maps/search/?api=1&query=${d.lat},${d.lon}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open in Google Maps
                    </a>
                    <button className="btn btn-small" onClick={() => setEditing(true)}>
                      Change
                    </button>
                    {d.gps_source === "manual" && (
                      <button
                        className="btn btn-small"
                        onClick={resetLocation}
                        title="Go back to the location stored in the file"
                      >
                        Reset
                      </button>
                    )}
                  </div>
                </section>
              ) : (
                <section>
                  <h4>Location</h4>
                  <div className="dim">No location data</div>
                  <button className="btn btn-small" onClick={() => setEditing(true)}>
                    Add location
                  </button>
                </section>
              )}

              {(d.camera || !!settings?.length) && (
                <section>
                  <h4>Camera</h4>
                  {d.camera && <div>{d.camera}</div>}
                  {d.lens && <div className="dim">{d.lens}</div>}
                  {settings && settings.length > 0 && <div className="dim">{settings.join(" · ")}</div>}
                </section>
              )}

              <section>
                <h4>File</h4>
                <div className="break">{d.name}</div>
                {d.edits && <div className="note">Edited in Photomap — the file itself is unchanged</div>}
                <div className="dim">
                  {[
                    d.width && d.height && `${d.width} × ${d.height}`,
                    formatBytes(d.size),
                    d.duration && formatDuration(d.duration),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
                <div className="dim break small">{d.path}</div>
                <div className="row">
                  <button className="btn btn-small" onClick={() => fetch(`/api/reveal/${id}`, { method: "POST" })}>
                    Show in Finder
                  </button>
                  <a className="btn btn-small" href={`/original/${id}`} target="_blank" rel="noreferrer">
                    {d.edits ? "Open original file" : "Open original"}
                  </a>
                </div>
              </section>

              <section>
                <button
                  className="btn btn-small btn-danger"
                  onClick={deletePhoto}
                  disabled={working}
                  title="Move the file to the Trash and remove it from Photomap"
                >
                  Delete…
                </button>
              </section>
            </>
          )}
        </aside>
      )}
      {/* Over the viewer rather than instead of it: the stage keeps its listeners. */}
      {editingPhoto && d && <Editor photo={{ id, name: d.name, edits: d.edits }} onDone={finishEditing} />}
    </div>
  );
}
