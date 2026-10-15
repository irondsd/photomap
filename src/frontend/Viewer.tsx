import { useEffect, useMemo, useState } from "react";
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
  type Points,
} from "./data";
import { DatePicker, toDateInput, type DateInput } from "./DatePicker";
import { LocationPicker } from "./LocationPicker";
import { MiniMap } from "./MiniMap";
import type { LatLon } from "./coords";

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
  /** The photo's location or date was changed; the caller should reload the index. */
  onLocationChange(): void;
}

const GPS_SOURCE_NOTE: Record<string, string> = {
  "inferred:burst": "Estimated: a photo with GPS was taken within minutes",
  "inferred:stay": "Estimated: photos before and after were taken at this spot",
  "inferred:home": "Estimated: probably home — photos before and after were taken here",
  "inferred:nearby": "Rough estimate: a photo with GPS was taken nearby within the hour",
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

export function Viewer({ points, ids, index, indexOf, onIndex, onClose, onShowOnMap, onLocationChange }: ViewerProps) {
  const id = ids[index]!;
  const i = indexOf(id);
  const isVideo = i != null && points.kind[i] === 2;
  const [detail, setDetail] = useState<PhotoDetail | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [showInfo, setShowInfo] = useState(() => localStorageGet("pm.info") !== "0");
  const [editing, setEditing] = useState(false);
  const [editingDate, setEditingDate] = useState(false);
  const hint = useMemo(() => (editing && i != null ? nearestTagged(points, i) : null), [editing, points, i]);

  useEffect(() => {
    setLoaded(false);
    setEditing(false);
    setEditingDate(false);
    const ac = new AbortController();
    fetch(`/api/photos/${id}`, { signal: ac.signal })
      .then((r) => r.json())
      .then(setDetail)
      .catch(() => {});
    // Warm the neighbours.
    for (const k of [index + 1, index - 1]) {
      const nid = ids[k];
      const j = nid != null ? indexOf(nid) : undefined;
      if (j != null && points.kind[j] !== 2) new Image().src = `/thumbs/l/${nid}`;
    }
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per photo, not when the list around it changes.
  }, [id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Typing coordinates must not flip photos or close the viewer.
      if ((e.target as HTMLElement)?.closest?.("input, textarea")) return;
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" && index < ids.length - 1) onIndex(index + 1);
      else if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
      else if (e.key === "i") toggleInfo();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const toggleInfo = () =>
    setShowInfo((v) => {
      localStorageSet("pm.info", v ? "0" : "1");
      return !v;
    });

  const d = detail?.id === id ? detail : null;

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
      <div className="viewer-stage" onClick={(e) => e.target === e.currentTarget && onClose()}>
        {isVideo ? (
          <video
            key={id}
            src={`/original/${id}`}
            poster={`/thumbs/l/${id}`}
            controls
            autoPlay
            playsInline
            className="viewer-media"
          />
        ) : (
          <>
            <img
              key={`s${id}`}
              src={`/thumbs/s/${id}`}
              alt=""
              className="viewer-media viewer-placeholder"
              aria-hidden
            />
            <img
              key={`l${id}`}
              src={`/thumbs/l/${id}`}
              alt={d?.name ?? ""}
              className={`viewer-media ${loaded ? "is-loaded" : ""}`}
              onLoad={() => setLoaded(true)}
            />
          </>
        )}
        <div className="viewer-top">
          <span className="viewer-pos">
            {nf.format(index + 1)} / {nf.format(ids.length)}
          </span>
          <div className="viewer-top-actions">
            <button className="btn btn-overlay" onClick={toggleInfo} title="Info (i)">
              Info
            </button>
            <button className="btn btn-overlay" onClick={onClose} title="Close (Esc)" aria-label="Close">
              ✕
            </button>
          </div>
        </div>
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

              {(d.camera || settings?.length) && (
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
                    Open original
                  </a>
                </div>
              </section>
            </>
          )}
        </aside>
      )}
    </div>
  );
}
