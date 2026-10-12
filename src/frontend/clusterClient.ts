import type { BBox, Points, Range } from "./data";
import type { Cluster, WorkerIn, WorkerOut } from "./cluster.worker";

export type { Cluster };

export interface ClusterResult {
  clusters: Cluster[];
  /** Geotagged photos inside the viewport that pass the filter, newest first. */
  visible: Int32Array;
  /** All geotagged photos passing the filter. */
  total: number;
}

/** Talks to the clustering worker; stale query results are dropped. */
export class ClusterClient {
  private worker = new Worker("/worker/cluster.js", { type: "module" });
  private seq = 0;
  private latestQuery = 0;
  private lastView: { bbox: BBox; zoom: number } | null = null;
  private expands = new Map<number, (r: { zoom: number; leaves: Int32Array | null }) => void>();

  constructor(private onResult: (r: ClusterResult) => void) {
    this.worker.onmessage = (e: MessageEvent<WorkerOut>) => {
      const m = e.data;
      if (m.type === "result") {
        if (m.seq === this.latestQuery) this.onResult({ clusters: m.clusters, visible: m.visible, total: m.total });
      } else {
        this.expands.get(m.seq)?.({ zoom: m.zoom, leaves: m.leaves });
        this.expands.delete(m.seq);
      }
    };
  }

  private post(m: WorkerIn) {
    this.worker.postMessage(m);
  }

  load(p: Points) {
    // Copies, so the main thread keeps its arrays.
    this.post({ type: "load", t: p.t.slice(), lat: p.lat.slice(), lon: p.lon.slice(), kind: p.kind.slice() });
  }

  filter(range: Range | null, kinds: number) {
    this.post({ type: "filter", range, kinds });
    if (this.lastView) this.query(this.lastView.bbox, this.lastView.zoom);
  }

  query(bbox: BBox, zoom: number) {
    this.lastView = { bbox, zoom };
    this.latestQuery = ++this.seq;
    this.post({ type: "query", seq: this.latestQuery, bbox, zoom });
  }

  expand(clusterId: number): Promise<{ zoom: number; leaves: Int32Array | null }> {
    const seq = ++this.seq;
    return new Promise((resolve) => {
      this.expands.set(seq, resolve);
      this.post({ type: "expand", seq, clusterId });
    });
  }

  dispose() {
    this.worker.terminate();
  }
}
