import { useEffect, useMemo } from "react";
import { nearestTagged, nf, SOURCE, type Points } from "./data";
import { LocationPicker } from "./LocationPicker";
import type { LatLon } from "./coords";

const STRIP = 12;

interface BulkLocationDialogProps {
  points: Points;
  /** Photo ids. */
  ids: number[];
  indexOf(id: number): number | undefined;
  onClose(): void;
  onDone(): void;
}

export function BulkLocationDialog({ points, ids, indexOf, onClose, onDone }: BulkLocationDialogProps) {
  // Point indices in time order.
  const indices = useMemo(
    () =>
      ids
        .map(indexOf)
        .filter((i): i is number => i != null)
        .sort((a, b) => a - b),
    [ids, indexOf],
  );

  const counts = useMemo(() => {
    const c = { file: 0, inferred: 0, manual: 0 };
    for (const i of indices) {
      const s = points.source[i];
      if (s === SOURCE.file) c.file++;
      else if (s === SOURCE.inferred) c.inferred++;
      else if (s === SOURCE.manual) c.manual++;
    }
    return c;
  }, [indices, points]);

  // Start where you were around the middle of the selection, ignoring the selection itself.
  const hint = useMemo(() => {
    if (!indices.length) return null;
    const inSelection = new Set(indices);
    return nearestTagged(points, indices[indices.length >> 1]!, (j) => inSelection.has(j));
  }, [indices, points]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target as HTMLElement)?.closest?.("input")) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async (c: LatLon) => {
    const r = await fetch("/api/locations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids, lat: c.lat, lon: c.lon }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? "Couldn't save the location");
    onDone();
  };

  const overridden = [
    counts.file && `${nf.format(counts.file)} with GPS from the file`,
    counts.inferred && `${nf.format(counts.inferred)} with an estimated location`,
    counts.manual && `${nf.format(counts.manual)} with a location you set`,
  ].filter(Boolean);
  const plural = indices.length === 1 ? "photo" : "photos";

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={`Set location for ${indices.length} ${plural}`}>
        <header className="modal-head">
          <h2>
            Set location for {nf.format(indices.length)} {plural}
          </h2>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="bulk-strip">
          {indices.slice(0, STRIP).map((i) => (
            <img key={i} src={`/thumbs/s/${points.id[i]}`} alt="" />
          ))}
          {indices.length > STRIP && <span className="bulk-more">+{nf.format(indices.length - STRIP)}</span>}
        </div>
        {overridden.length > 0 && (
          <p className="note">
            {overridden.join(", ")} will be overridden. Reset brings back what the files say.
          </p>
        )}
        <LocationPicker initial={null} hint={hint} onSave={save} onCancel={onClose} />
      </div>
    </div>
  );
}
