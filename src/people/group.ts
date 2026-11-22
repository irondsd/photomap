export const EMBEDDING_SIZE = 128;
const MATCH_SCORE = 0.55;
/** Close enough to ask "Is this …?" but not to merge on its own. */
const SUGGEST_SCORE = 0.45;
/** Key for a "this group is not that person" answer. */
export const rejectionKey = (person: number, named: number) => `${person}:${named}`;

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

  /**
   * The closest group that is similar enough. There is deliberately no "ambiguity" margin: two close
   * candidates are almost always duplicate groups of the same person, and refusing to pick one only
   * starts a third. A different face from the same photo cannot take an already assigned group.
   */
  match(vector: Float32Array, inPhoto: Set<number>): number | null {
    let best = MATCH_SCORE;
    let id: number | null = null;
    const centers = this.centers;
    for (let slot = 0; slot < this.ids.length; slot++) {
      const candidate = this.ids[slot]!;
      if (inPhoto.has(candidate)) continue;
      const offset = slot * EMBEDDING_SIZE;
      let score = 0;
      for (let i = 0; i < EMBEDDING_SIZE; i++) score += centers[offset + i]! * vector[i]!;
      if (score >= best) {
        best = score;
        id = candidate;
      }
    }
    return id;
  }
}

export interface GroupedFace {
  id: number;
  photo: number;
  person: number;
  quality: number;
  vector: Float32Array;
}

/**
 * Rebuild face groups. Faces of `fixed` people (named or hidden, i.e. curated by the user) never
 * move. With `reassign`, every other face is matched again from scratch against the fixed people
 * and each other; otherwise the current groups are kept. Then duplicate groups are merged: a free
 * group joins the most similar fixed or larger group, as long as the two never share a photo.
 * Returns the new person per face id. New groups get negative ids.
 */
export function regroupFaces(
  faces: GroupedFace[],
  fixed: Set<number>,
  reassign: boolean,
  rejected = new Set<string>(),
): Map<number, number> {
  const assigned = new Map<number, number>();
  for (const face of faces) if (!reassign || fixed.has(face.person)) assigned.set(face.id, face.person);

  if (reassign) {
    const groups = new FaceGroups();
    const fixedInPhoto = new Map<number, Set<number>>();
    for (const face of faces) {
      if (!fixed.has(face.person)) continue;
      groups.add(face.person, face.vector);
      let people = fixedInPhoto.get(face.photo);
      if (!people) fixedInPhoto.set(face.photo, (people = new Set()));
      people.add(face.person);
    }
    const free = faces
      .filter((face) => !fixed.has(face.person))
      .sort((a, b) => a.photo - b.photo || b.quality - a.quality);
    let next = -1;
    let photo = NaN;
    let inPhoto = new Set<number>();
    for (const face of free) {
      if (face.photo !== photo) {
        photo = face.photo;
        inPhoto = new Set(fixedInPhoto.get(photo));
      }
      const id = groups.match(face.vector, inPhoto) ?? next--;
      inPhoto.add(id);
      groups.add(id, face.vector);
      assigned.set(face.id, id);
    }
  }

  // Merge duplicate groups.
  interface Group {
    id: number;
    sum: Float32Array;
    center: Float32Array;
    photos: Set<number>;
    fixed: boolean;
  }
  const byId = new Map<number, Group>();
  for (const face of faces) {
    const id = assigned.get(face.id)!;
    let group = byId.get(id);
    if (!group) {
      group = {
        id,
        sum: new Float32Array(EMBEDDING_SIZE),
        center: new Float32Array(EMBEDDING_SIZE),
        photos: new Set(),
        fixed: fixed.has(id),
      };
      byId.set(id, group);
    }
    for (let i = 0; i < EMBEDDING_SIZE; i++) group.sum[i]! += face.vector[i]!;
    group.photos.add(face.photo);
  }
  const center = (group: Group) => {
    let squared = 0;
    for (let i = 0; i < EMBEDDING_SIZE; i++) squared += group.sum[i]! * group.sum[i]!;
    const norm = Math.sqrt(squared) || 1;
    for (let i = 0; i < EMBEDDING_SIZE; i++) group.center[i] = group.sum[i]! / norm;
  };
  for (const group of byId.values()) center(group);

  const into = new Map<number, number>();
  const sharesPhoto = (a: Group, b: Group) => {
    for (const photo of a.photos) if (b.photos.has(photo)) return true;
    return false;
  };
  for (let merged = true; merged;) {
    merged = false;
    // Each free group proposes its best target: a fixed group, or a free one at least as large.
    const proposals: { score: number; source: Group; target: Group }[] = [];
    for (const source of byId.values()) {
      if (source.fixed) continue;
      let best = MATCH_SCORE;
      let target: Group | null = null;
      for (const candidate of byId.values()) {
        if (candidate === source) continue;
        const size = candidate.photos.size - source.photos.size;
        if (!candidate.fixed && (size < 0 || (size === 0 && candidate.id > source.id))) continue;
        if (rejected.has(rejectionKey(source.id, candidate.id))) continue;
        let score = 0;
        for (let i = 0; i < EMBEDDING_SIZE; i++) score += candidate.center[i]! * source.center[i]!;
        if (score < best || sharesPhoto(source, candidate)) continue;
        best = score;
        target = candidate;
      }
      if (target) proposals.push({ score: best, source, target });
    }
    // Most confident first, so a weak merge between strays can't block a strong one into a person.
    const grown = new Set<Group>();
    for (const { source, target } of proposals.sort((a, b) => b.score - a.score)) {
      if (!byId.has(source.id) || !byId.has(target.id) || grown.has(source) || sharesPhoto(source, target)) continue;
      for (let i = 0; i < EMBEDDING_SIZE; i++) target.sum[i]! += source.sum[i]!;
      for (const photo of source.photos) target.photos.add(photo);
      center(target);
      byId.delete(source.id);
      into.set(source.id, target.id);
      grown.add(target);
      merged = true;
    }
  }

  const resolve = (id: number): number => {
    const target = into.get(id);
    return target == null ? id : resolve(target);
  };
  return new Map([...assigned].map(([face, id]) => [face, resolve(id)]));
}

export interface NameSuggestion {
  /** The unnamed group. */
  id: number;
  /** The named person it most resembles. */
  target: number;
  score: number;
}

/**
 * For each unnamed group, the most similar named person that the user hasn't already said it isn't,
 * when similar enough to ask about. Most confident first.
 */
export function suggestNames(
  faces: { person: number; vector: Float32Array }[],
  unnamed: Set<number>,
  named: Set<number>,
  rejected: Set<string>,
): NameSuggestion[] {
  const sums = new Map<number, Float32Array>();
  for (const face of faces) {
    if (!unnamed.has(face.person) && !named.has(face.person)) continue;
    let sum = sums.get(face.person);
    if (!sum) sums.set(face.person, (sum = new Float32Array(EMBEDDING_SIZE)));
    for (let i = 0; i < EMBEDDING_SIZE; i++) sum[i]! += face.vector[i]!;
  }
  for (const sum of sums.values()) {
    let squared = 0;
    for (let i = 0; i < EMBEDDING_SIZE; i++) squared += sum[i]! * sum[i]!;
    const norm = Math.sqrt(squared) || 1;
    for (let i = 0; i < EMBEDDING_SIZE; i++) sum[i]! /= norm;
  }
  const people = [...named].flatMap((id) => (sums.has(id) ? [[id, sums.get(id)!] as const] : []));
  const suggestions: NameSuggestion[] = [];
  for (const id of unnamed) {
    const center = sums.get(id);
    if (!center) continue;
    let best = SUGGEST_SCORE;
    let target: number | null = null;
    for (const [candidate, other] of people) {
      if (rejected.has(rejectionKey(id, candidate))) continue;
      let score = 0;
      for (let i = 0; i < EMBEDDING_SIZE; i++) score += center[i]! * other[i]!;
      if (score >= best) {
        best = score;
        target = candidate;
      }
    }
    if (target != null) suggestions.push({ id, target, score: best });
  }
  return suggestions.sort((a, b) => b.score - a.score || a.id - b.id);
}
