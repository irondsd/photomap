import { useEffect, useRef } from "react";
import { Map as MlMap, Marker, NavigationControl } from "maplibre-gl";
import { collapseAttribution, STYLE } from "./map";

/** Small map with a pin, for the viewer's info panel. Moves instead of reloading between photos. */
export function MiniMap({ lat, lon }: { lat: number; lon: number }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const pin = useRef<Marker | null>(null);

  useEffect(() => {
    const m = new MlMap({
      container: el.current!,
      style: STYLE.detailed,
      center: [lon, lat],
      zoom: 13,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
      // The panel scrolls; the wheel shouldn't get stuck zooming the map.
      scrollZoom: false,
    });
    m.touchZoomRotate.disableRotation();
    collapseAttribution(m);
    m.addControl(new NavigationControl({ showCompass: false }), "top-right");
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#e8590c";
    pin.current = new Marker({ color: accent }).setLngLat([lon, lat]).addTo(m);
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    pin.current?.setLngLat([lon, lat]);
    map.current?.jumpTo({ center: [lon, lat] });
  }, [lat, lon]);

  return <div ref={el} className="minimap" />;
}
