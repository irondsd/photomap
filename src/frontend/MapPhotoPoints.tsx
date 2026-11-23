import { useLayoutEffect, useRef } from "react";
import { Popup, type Map as MlMap, type MapMouseEvent } from "maplibre-gl";
import { passesPhotoFilter, type Points, type Range } from "./data";
import { PointGrid, spreadPhotoPoints, type PhotoPoint } from "./pointLayout";
import { usePhotoUrls } from "./photoVisibility";

interface Props {
  map: MlMap;
  points: Points;
  visible: Int32Array;
  range: Range | null;
  kinds: number;
  membership: Uint8Array | null;
  dark: boolean;
  onOpen(index: number): void;
}

const SPREAD_ZOOM = 15;
const EDGE_PADDING = 16;

export function MapPhotoPoints(props: Props) {
  const { map, points, visible, range, kinds, membership, dark } = props;
  const { thumbnail } = usePhotoUrls();
  const latest = useRef({ ...props, thumbnail });
  latest.current = { ...props, thumbnail };
  const refresh = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const container = map.getCanvasContainer();
    const canvas = document.createElement("canvas");
    canvas.className = "pm-point-layer";
    canvas.setAttribute("aria-hidden", "true");
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    container.append(canvas);

    const popup = new Popup({
      className: "pm-point-preview",
      closeButton: false,
      closeOnClick: false,
      focusAfterOpen: false,
      offset: 9,
      maxWidth: "none",
    });
    const coarse = matchMedia("(pointer: coarse)");
    let hovered: PhotoPoint | null = null;
    let frame: number | null = null;
    let drawnPoints: Points | null = null;
    let grid = new PointGrid<PhotoPoint>();

    const clearPreview = () => {
      if (!hovered) return;
      hovered = null;
      popup.remove();
      container.classList.remove("pm-point-hover");
    };

    const paint = () => {
      frame = null;
      const data = latest.current;
      const { clientWidth: width, clientHeight: height } = map.getCanvas();
      if (!width || !height) return;
      const pixelRatio = map.getPixelRatio();
      const pixelWidth = Math.round(width * pixelRatio);
      const pixelHeight = Math.round(height * pixelRatio);
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      ctx.clearRect(0, 0, width, height);
      drawnPoints = data.points;
      grid = new PointGrid<PhotoPoint>();

      const spread = map.getZoom() >= SPREAD_ZOOM;
      const center = map.getCenter().lng;
      const pixels = new Set<number>();
      const projected: PhotoPoint[] = [];
      for (const index of data.visible) {
        if (
          (data.membership && !data.membership[index]) ||
          !passesPhotoFilter(data.points, index, data.range, data.kinds)
        )
          continue;
        const lon = data.points.lon[index]!;
        const lat = data.points.lat[index]!;
        if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) continue;
        const wrappedLon = lon + 360 * Math.round((center - lon) / 360);
        const { x, y } = map.project([wrappedLon, lat]);
        if (!(x >= -EDGE_PADDING && y >= -EDGE_PADDING && x <= width + EDGE_PADDING && y <= height + EDGE_PADDING))
          continue;
        // At distant zooms, several photos can project to the same pixel. Keep the newest one pickable.
        if (!spread) {
          const pixel = Math.round(y) * (width + 2 * EDGE_PADDING + 1) + Math.round(x);
          if (pixels.has(pixel)) continue;
          pixels.add(pixel);
        }
        projected.push({ x, y, index });
      }

      const radius = spread ? 3.8 : 2.6;
      ctx.beginPath();
      for (const point of spread ? spreadPhotoPoints(projected) : projected) {
        if (point.x < -radius || point.x > width + radius || point.y < -radius || point.y > height + radius) continue;
        grid.add(point);
        ctx.moveTo(point.x + radius, point.y);
        ctx.arc(point.x, point.y, radius, 0, 2 * Math.PI);
      }
      const colors = getComputedStyle(canvas);
      ctx.fillStyle = colors.color;
      ctx.fill();
      if (spread) {
        ctx.strokeStyle = colors.getPropertyValue("--panel").trim();
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
    };

    const requestPaint = () => {
      frame ??= requestAnimationFrame(paint);
    };

    const pointAt = (event: MapMouseEvent) => {
      // Markers and controls take precedence over the point underneath them.
      if (
        map.isMoving() ||
        frame != null ||
        drawnPoints !== latest.current.points ||
        event.originalEvent.target !== map.getCanvas()
      )
        return null;
      return grid.nearest(event.point.x, event.point.y, coarse.matches ? 12 : 7);
    };

    const onHover = (event: MapMouseEvent) => {
      const point = pointAt(event);
      if (!point) return clearPreview();
      if (point === hovered) return;
      hovered = point;
      container.classList.add("pm-point-hover");
      const data = latest.current;
      const ratio = data.points.aspect[point.index]!;
      const aspect = Number.isFinite(ratio) && ratio > 0 ? ratio : 1.5;
      const image = document.createElement("img");
      image.alt = "Photo preview";
      image.width = Math.max(1, Math.round(Math.min(216, 160 * aspect)));
      image.height = Math.max(1, Math.round(Math.min(160, 216 / aspect)));
      image.src = data.thumbnail(data.points.id[point.index]!, "m");
      popup
        .setLngLat(map.unproject([point.x, point.y]))
        .setDOMContent(image)
        .addTo(map);
    };

    const onClick = (event: MapMouseEvent) => {
      const point = pointAt(event);
      if (!point) return;
      clearPreview();
      latest.current.onOpen(point.index);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") clearPreview();
    };

    refresh.current = () => {
      clearPreview();
      requestPaint();
    };
    map.on("move", requestPaint);
    map.on("resize", requestPaint);
    map.on("movestart", clearPreview);
    map.on("mousemove", onHover);
    map.on("mouseout", clearPreview);
    map.on("click", onClick);
    window.addEventListener("keydown", onKey);
    requestPaint();

    return () => {
      refresh.current = null;
      if (frame != null) cancelAnimationFrame(frame);
      clearPreview();
      canvas.remove();
      map.off("move", requestPaint);
      map.off("resize", requestPaint);
      map.off("movestart", clearPreview);
      map.off("mousemove", onHover);
      map.off("mouseout", clearPreview);
      map.off("click", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [map]);

  useLayoutEffect(() => {
    refresh.current?.();
  }, [points, visible, range, kinds, membership, dark, thumbnail]);

  return null;
}
