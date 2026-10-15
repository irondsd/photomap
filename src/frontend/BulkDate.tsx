import { useEffect, useMemo } from "react";
import { nf, PRECISION, type Points } from "./data";
import { DatePicker, type DateInput } from "./DatePicker";

const STRIP = 12;

interface BulkDateDialogProps {
  points: Points;
  /** Photo ids. */
  ids: number[];
  indexOf(id: number): number | undefined;
  onClose(): void;
  onDone(): void;
}

export function BulkDateDialog({ points, ids, indexOf, onClose, onDone }: BulkDateDialogProps) {
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
    const c = { dated: 0, manual: 0 };
    for (const i of indices) {
      if (points.dateManual[i]) c.manual++;
      else if (!Number.isNaN(points.t[i]!) && points.precision[i]! <= PRECISION.estimated) c.dated++;
    }
    return c;
  }, [indices, points]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target as HTMLElement)?.closest?.("input")) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async (v: DateInput) => {
    const r = await fetch("/api/dates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids, date: v.date, time: v.time || null }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? "Couldn't save the date");
    onDone();
  };

  const overridden = [
    counts.dated && `${nf.format(counts.dated)} with a known date`,
    counts.manual && `${nf.format(counts.manual)} with a date you set`,
  ].filter(Boolean);
  const plural = indices.length === 1 ? "photo" : "photos";

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={`Set date for ${indices.length} ${plural}`}>
        <header className="modal-head">
          <h2>
            Set date for {nf.format(indices.length)} {plural}
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
        {(indices.length > 1 || overridden.length > 0) && (
          <p className="note">
            {indices.length > 1 && <>All of them get the same date. </>}
            {overridden.length > 0 && <>{overridden.join(", ")} will be overridden. Reset brings back what the files say.</>}
          </p>
        )}
        <DatePicker initial={null} onSave={save} onCancel={onClose} />
      </div>
    </div>
  );
}
