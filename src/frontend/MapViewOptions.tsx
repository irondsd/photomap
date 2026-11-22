import { useEffect, useId, useRef, useState } from "react";

export function MapViewOptions({
  heatmap,
  onHeatmapChange,
}: {
  heatmap: boolean;
  onHeatmapChange: (on: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useId();

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", closeOutside);
    return () => window.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  return (
    <div
      ref={root}
      className="map-view-options"
      onKeyDown={(event) => {
        if (!open || event.key !== "Escape") return;
        event.stopPropagation();
        setOpen(false);
        button.current?.focus();
      }}
    >
      <button
        ref={button}
        type="button"
        className="map-view-options-button"
        aria-label="View options"
        aria-expanded={open}
        aria-controls={panel}
        title="View options"
        onClick={() => setOpen(!open)}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="7.2" fill="currentColor" />
          <path
            d="m8 10.5 4-2.25 4 2.25-4 2.25-4-2.25Zm0 3 4 2.25 4-2.25"
            fill="none"
            stroke="var(--panel)"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <div id={panel} className="map-view-options-panel" hidden={!open}>
        <label>
          Heatmap
          <input
            type="checkbox"
            role="switch"
            checked={heatmap}
            onChange={(event) => onHeatmapChange(event.currentTarget.checked)}
          />
        </label>
      </div>
    </div>
  );
}
