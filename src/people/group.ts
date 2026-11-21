export const EMBEDDING_SIZE = 128;
const MATCH_SCORE = 0.55;
const MATCH_MARGIN = 0.04;

/** Keep normalized centroids for cosine search and sums for incremental updates. */
export class FaceGroups {
  private ids: number[] = [];
  private slots = new Map<number, number>();
  private sums: Float32Array[] = [];
  private centers = new Float32Array(EMBEDDING_SIZE * 256);

  add(id: number, vector: Float32Array) {
    let slot = this.slots.get(id);
    if (slot == null) {
      slot = this.ids.length;
      if (slot * EMBEDDING_SIZE === this.centers.length) {
        const expanded = new Float32Array(this.centers.length * 2);
        expanded.set(this.centers);
        this.centers = expanded;
      }
      this.ids.push(id);
      this.slots.set(id, slot);
      this.sums.push(new Float32Array(EMBEDDING_SIZE));
    }

    const sum = this.sums[slot]!;
    let squared = 0;
    for (let i = 0; i < EMBEDDING_SIZE; i++) {
      const value = sum[i]! + vector[i]!;
      sum[i] = value;
      squared += value * value;
    }
    const offset = slot * EMBEDDING_SIZE;
    const norm = Math.sqrt(squared) || 1;
    for (let i = 0; i < EMBEDDING_SIZE; i++) this.centers[offset + i] = sum[i]! / norm;
  }

  match(vector: Float32Array, inPhoto: Set<number>): number | null {
    let best = -1;
    let next = -1;
    let slot = -1;
    const centers = this.centers;
    for (let candidate = 0; candidate < this.ids.length; candidate++) {
      const offset = candidate * EMBEDDING_SIZE;
      let score = 0;
      for (let i = 0; i < EMBEDDING_SIZE; i++) score += centers[offset + i]! * vector[i]!;
      if (score > best) {
        next = best;
        best = score;
        slot = candidate;
      } else if (score > next) {
        next = score;
      }
    }
    const id = this.ids[slot];
    // A different detected face from the same photo cannot take an already assigned group.
    return id != null && best >= MATCH_SCORE && best - next >= MATCH_MARGIN && !inPhoto.has(id) ? id : null;
  }
}
