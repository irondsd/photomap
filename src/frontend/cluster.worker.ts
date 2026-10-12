/// <reference lib="webworker" />
import Supercluster, { type ClusterProperties } from "supercluster";
import type { BBox, Range } from "./data";

export type WorkerIn =
  | { type: "load"; t: Float64Array; lat: Float32Array; lon: Float32Array; kind: Uint8Array }
  | { type: "filter"; range: Range | null; kinds: number }
  | { type: "query"; seq: number; bbox: BBox; zoom: number }
  | { type: "expand"; seq: number; clusterId: number };

export interface Cluster {
  /** Cluster id from supercluster, or -1 for a single photo. */
  cid: number;
  lon: number;
  lat: number;
  count: number;
  /** Point index of the representative (most recent) photo. */
  rep: number;
}

export type WorkerOut =
  | { type: "result"; seq: number; clusters: Cluster[]; visible: Int32Array; total: number }
  | { type: "expand"; seq: number; zoom: number; leaves: Int32Array | null };

export const MAX_CLUSTER_ZOOM = 17;

interface Props {
  i: number;
}
interface Agg {
  rep: number;
  rt: number;
}

let t: Float64Array<ArrayBufferLike> = new Float64Array(0);
let lat: Float32Array<ArrayBufferLike> = new Float32Array(0);
let lon: Float32Array<ArrayBufferLike> = new Float32Array(0);
let kind: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
let filtered = new Int32Array(0); // geotagged indices passing the filter, ascending time
let index: Supercluster<Props, Agg> | null = null;

function rebuild(range: Range | null, kinds: number) {
  const idx: number[] = [];
  for (let i = 0; i < t.length; i++) {
    const la = lat[i]!;
    if (la !== la) continue; // NaN: no location
    if (!((1 << kind[i]!) & kinds)) continue;
    if (range) {
      const ti = t[i]!;
      if (!(ti >= range[0] && ti < range[1])) continue;
    }
    idx.push(i);
  }
  filtered = Int32Array.from(idx);
  index = new Supercluster<Props, Agg>({
    radius: 84,
    maxZoom: MAX_CLUSTER_ZOOM,
    minPoints: 2,
    map: (p) => ({ rep: p.i, rt: t[p.i]! }),
    reduce: (acc, p) => {
      // Keep the most recent photo as the cover; NaN never wins over a real date.
      if (p.rt > acc.rt || (acc.rt !== acc.rt && p.rt === p.rt)) {
        acc.rep = p.rep;
        acc.rt = p.rt;
      }
    },
  });
  index.load(
    idx.map((i) => ({
      type: "Feature" as const,
      properties: { i },
      geometry: { type: "Point" as const, coordinates: [lon[i]!, lat[i]!] },
    })),
  );
}

function inBBox(la: number, lo: number, b: BBox) {
  if (la < b[1] || la > b[3]) return false;
  return b[0] <= b[2] ? lo >= b[0] && lo <= b[2] : lo >= b[0] || lo <= b[2];
}

function query(seq: number, bbox: BBox, zoom: number): WorkerOut {
  if (!index) return { type: "result", seq, clusters: [], visible: new Int32Array(0), total: 0 };
  const features = index.getClusters(bbox, Math.floor(zoom));
  const clusters: Cluster[] = features.map((f) => {
    const [x, y] = f.geometry.coordinates as [number, number];
    const p = f.properties as Partial<ClusterProperties> & Partial<Agg> & Partial<Props>;
    return p.cluster
      ? { cid: p.cluster_id!, lon: x, lat: y, count: p.point_count!, rep: p.rep! }
      : { cid: -1, lon: x, lat: y, count: 1, rep: p.i! };
  });
  // Newest first, like a camera roll.
  const vis: number[] = [];
  for (let k = filtered.length - 1; k >= 0; k--) {
    const i = filtered[k]!;
    if (inBBox(lat[i]!, lon[i]!, bbox)) vis.push(i);
  }
  return { type: "result", seq, clusters, visible: Int32Array.from(vis), total: filtered.length };
}

function expand(seq: number, clusterId: number): WorkerOut {
  if (!index) return { type: "expand", seq, zoom: 0, leaves: null };
  const zoom = index.getClusterExpansionZoom(clusterId);
  if (zoom <= MAX_CLUSTER_ZOOM) return { type: "expand", seq, zoom, leaves: null };
  // Can't split further (same spot): hand back the photos instead.
  const leaves = index.getLeaves(clusterId, Infinity).map((f) => (f.properties as Props).i);
  leaves.sort((a, b) => t[b]! - t[a]!);
  return { type: "expand", seq, zoom, leaves: Int32Array.from(leaves) };
}

self.onmessage = (e: MessageEvent<WorkerIn>) => {
  const m = e.data;
  switch (m.type) {
    case "load":
      ({ t, lat, lon, kind } = m);
      index = null;
      filtered = new Int32Array(0);
      break;
    case "filter":
      rebuild(m.range, m.kinds);
      break;
    case "query": {
      const out = query(m.seq, m.bbox, m.zoom);
      if (out.type === "result") self.postMessage(out, [out.visible.buffer]);
      break;
    }
    case "expand": {
      const out = expand(m.seq, m.clusterId);
      self.postMessage(out, out.type === "expand" && out.leaves ? [out.leaves.buffer] : []);
      break;
    }
  }
};
