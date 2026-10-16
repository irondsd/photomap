import { useEffect, useId, useRef, useState } from "react";
import { Map as MlMap, Marker, NavigationControl } from "maplibre-gl";
import { collapseAttribution, STYLE } from "./map";
import { formatCoords, parseCoords, type LatLon } from "./coords";
import { searchPlaces, type Place } from "./places";

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
  // Text that isn't coordinates is a place search; picking a result or the map clears it.
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Place[]>([]);
  const [active, setActive] = useState(0);
  const listId = useId();

  const closeSearch = () => {
    setQuery("");
    setResults([]);
  };

  // Position chosen on the map: move the pin and show the numbers.
  const placeFromMap = (c: LatLon) => {
    setPos(c);
    setText(formatCoords(c));
    setError(null);
    closeSearch();
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the map is created once; later changes go through the effects below.
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
      pin.current = new Marker({
        color: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#e8590c",
        draggable: true,
      });
      pin.current.on("dragend", () => {
        const ll = pin.current!.getLngLat();
        placeFromMap({ lat: ll.lat, lon: ll.lng });
      });
    }
    pin.current.setLngLat([pos.lon, pos.lat]).addTo(map);
  }, [pos]);

  useEffect(() => {
    if (query.length < 2) {
      setResults([]);
      return;
    }
    const ac = new AbortController();
    const timer = setTimeout(async () => {
      // Rank places near what the map shows, or near the hint while the map is still the whole world.
      const map = mapRef.current;
      const center = map?.getCenter();
      const near =
        map && center && map.getZoom() >= 4
          ? { at: { lat: center.lat, lon: center.lng }, zoom: map.getZoom() }
          : hint
            ? { at: hint.at, zoom: 10 }
            : null;
      try {
        const found = await searchPlaces(query, near, ac.signal);
        setResults(found);
        setActive(0);
        setError(
          found.length
            ? null
            : "No places found. You can also paste coordinates like 48.858370, 2.294481 or a Google Maps link",
        );
      } catch (err) {
        if (!ac.signal.aborted) setError((err as Error).message);
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      ac.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- searches follow the typed text only.
  }, [query]);

  const onType = (value: string) => {
    setText(value);
    setError(null);
    const c = parseCoords(value);
    if (!c) {
      setQuery(value.trim());
      return;
    }
    closeSearch();
    setPos(c);
    mapRef.current?.flyTo({ center: [c.lon, c.lat], zoom: Math.max(mapRef.current.getZoom(), 15), duration: 600 });
  };

  const pick = (place: Place) => {
    setPos(place.at);
    setText(place.context ? `${place.name}, ${place.context}` : place.name);
    setError(null);
    closeSearch();
    const map = mapRef.current;
    if (!map) return;
    // Show a whole town or park; zoom right in on a street or a building.
    if (place.bounds) map.fitBounds(place.bounds, { padding: 32, maxZoom: 16, duration: 600 });
    else map.flyTo({ center: [place.at.lon, place.at.lat], zoom: 16, duration: 600 });
  };

  // With nothing chosen, saving takes the suggested spot: it is usually right.
  // Not while the box holds text that didn't parse, so a typo never saves the hint.
  const target = pos ?? (text.trim() ? null : (hint?.at ?? null));

  const save = async () => {
    if (!target || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(target);
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  };

  return (
    <div className="picker">
      <div ref={mapEl} className="picker-map" />
      <input
        className="input"
        value={text}
        onChange={(e) => onType(e.target.value)}
        onKeyDown={(e) => {
          if (results.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            const step = e.key === "ArrowDown" ? 1 : -1;
            setActive((active + step + results.length) % results.length);
          } else if (e.key === "Enter") {
            if (results.length) pick(results[active]!);
            // While a search is pending or found nothing, Enter must not save the previous pin.
            else if (!query) save();
          } else if (e.key === "Escape") {
            if (results.length) setResults([]);
            else onCancel();
          }
        }}
        placeholder="Search a place, or paste coordinates or a Google Maps link"
        spellCheck={false}
        autoComplete="off"
        role="combobox"
        aria-label="Location"
        aria-expanded={results.length > 0}
        aria-controls={listId}
        aria-activedescendant={results.length ? `${listId}-${active}` : undefined}
        autoFocus
      />
      {results.length > 0 && (
        <ul className="picker-results" id={listId} role="listbox">
          {results.map((r, i) => (
            <li
              key={`${r.at.lat},${r.at.lon},${r.name}`}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? "is-active" : undefined}
              // Keep focus in the box, so Enter and the arrows still work after a click.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(r)}
            >
              <span className="picker-result-name">{r.name}</span>
              {r.context && <span className="dim small">{r.context}</span>}
            </li>
          ))}
        </ul>
      )}
      <div className="dim small">
        {pos ? "Drag the pin to adjust." : "Search above, or click the map to drop a pin."}
        {hint && <> The grey dot is {hint.label}.</>}
        {!pos && target && <> Save without a pin to use it.</>}
      </div>
      {error && <div className="error">{error}</div>}
      <div className="row">
        <button className="btn btn-small btn-primary" disabled={!target || saving} onClick={save}>
          {saving ? "Saving…" : "Save location"}
        </button>
        <button className="btn btn-small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
