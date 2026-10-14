import { useEffect, useRef, useState } from "react";
import { Map as MlMap, Marker, NavigationControl } from "maplibre-gl";
import { collapseAttribution, STYLE } from "./map";
import { formatCoords, parseCoords, type LatLon } from "./coords";

interface LocationPickerProps {
  /** Current location, when changing one. */
  initial: LatLon | null;
  /** Where to start looking: e.g. where the nearest photo in time was taken. */
  hint: { at: LatLon; label: string } | null;
  onSave(c: LatLon): Promise<void>;
  onCancel(): void;
}

export function LocationPicker({ initial, hint, onSave, onCancel }: LocationPickerProps) {
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const pin = useRef<Marker | null>(null);
  const [pos, setPos] = useState<LatLon | null>(initial);
  const [text, setText] = useState(initial ? formatCoords(initial) : "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Position chosen on the map: move the pin and show the numbers.
  const placeFromMap = (c: LatLon) => {
    setPos(c);
    setText(formatCoords(c));
    setError(null);
  };

  useEffect(() => {
    const start = initial ?? hint?.at ?? null;
    const map = new MlMap({
      container: mapEl.current!,
      style: STYLE.detailed,
      center: start ? [start.lon, start.lat] : [20, 25],
      zoom: initial ? 15 : hint ? 13 : 1.2,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
    });
    map.touchZoomRotate.disableRotation();
    collapseAttribution(map);
    map.addControl(new NavigationControl({ showCompass: false }), "top-right");
    map.getCanvas().style.cursor = "crosshair";
    map.on("click", (e) => placeFromMap({ lat: e.lngLat.lat, lon: e.lngLat.lng }));
    // Shown when changing too: for a wrong location, the nearest photo in time is the best clue.
    if (hint) {
      const dot = document.createElement("div");
      dot.className = "picker-hint";
      dot.title = hint.label;
      new Marker({ element: dot }).setLngLat([hint.at.lon, hint.at.lat]).addTo(map);
    }
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      pin.current = null;
    };
  }, []);

  // Keep the draggable pin in sync with the chosen position.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!pos) {
      pin.current?.remove();
      pin.current = null;
      return;
    }
    if (!pin.current) {
      pin.current = new Marker({ color: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#e8590c", draggable: true });
      pin.current.on("dragend", () => {
        const ll = pin.current!.getLngLat();
        placeFromMap({ lat: ll.lat, lon: ll.lng });
      });
    }
    pin.current.setLngLat([pos.lon, pos.lat]).addTo(map);
  }, [pos]);

  const onType = (value: string) => {
    setText(value);
    const c = parseCoords(value);
    setError(value.trim() && !c ? "Paste coordinates like 48.858370, 2.294481 or a Google Maps link" : null);
    if (!c) return;
    setPos(c);
    mapRef.current?.flyTo({ center: [c.lon, c.lat], zoom: Math.max(mapRef.current.getZoom(), 15), duration: 600 });
  };

  const save = async () => {
    if (!pos || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(pos);
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  };

  return (
    <div className="picker">
      <div ref={mapEl} className="picker-map" />
      <input
        className="input mono"
        value={text}
        onChange={(e) => onType(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") onCancel();
        }}
        placeholder="Paste coordinates or a Google Maps link"
        spellCheck={false}
        aria-label="Coordinates"
        autoFocus
      />
      <div className="dim small">
        {pos ? "Drag the pin to adjust." : "Click the map to drop a pin."}
        {hint && <> The grey dot is {hint.label}.</>}
      </div>
      {error && <div className="error">{error}</div>}
      <div className="row">
        <button className="btn btn-small btn-primary" disabled={!pos || saving} onClick={save}>
          {saving ? "Saving…" : "Save location"}
        </button>
        <button className="btn btn-small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
