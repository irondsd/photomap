import { expect, test } from "bun:test";
import { addRoot, db, setPhotosPrivate } from "../db";
import { EMBEDDING_SIZE, FaceGroups } from "./group";
import {
  initPeople,
  listPeople,
  mergePeople,
  namePerson,
  personDetail,
  personPhotos,
  setPersonCover,
  visibleFace,
} from "./store";

const embedding = (x: number, y: number, z = 0) => {
  const values = new Float32Array(EMBEDDING_SIZE);
  values.set([x, y, z]);
  return values;
};

test("face grouping rejects ambiguous matches and duplicate assignments within a photo", () => {
  const groups = new FaceGroups();
  groups.add(1, embedding(1, 0));
  groups.add(2, embedding(0, 1));

  expect(groups.match(embedding(0.96, 0.28), new Set())).toBe(1);
  expect(groups.match(embedding(Math.SQRT1_2, Math.SQRT1_2), new Set())).toBeNull();
  expect(groups.match(embedding(0, 0, 1), new Set())).toBeNull();
  expect(groups.match(embedding(1, 0), new Set([1]))).toBeNull();

  groups.add(1, embedding(0.96, 0.28));
  expect(groups.match(embedding(0.8, 0.6), new Set())).toBe(1);
});

test("merging keeps the target, deduplicates photo counts, and respects photo visibility", () => {
  db.run("SAVEPOINT people_test");
  try {
    const root = addRoot("/people-test");
    initPeople();
    const photo = (name: string, time: number, source: string) => {
      const id = Number(
        db.run(
          `INSERT INTO photos
        (root_id, path, rel_dir, name, ext, kind, size, mtime, scan_gen, indexed_at, taken_local, time_source)
        VALUES (?, ?, '', ?, 'jpg', 'photo', 1, 1, 0, 0, ?, ?)`,
          [root.id, `${root.path}/${name}`, name, time, source],
        ).lastInsertRowid,
      );
      db.run("INSERT INTO face_scans (photo_id, mtime, size) VALUES (?, 1, 1)", [id]);
      return id;
    };
    const publicPhoto = photo("public.jpg", 10, "folder");
    const privatePhoto = photo("private.jpg", 20, "exif");
    setPhotosPrivate([privatePhoto], true);
    const a = Number(db.run("INSERT INTO people DEFAULT VALUES").lastInsertRowid);
    const b = Number(db.run("INSERT INTO people DEFAULT VALUES").lastInsertRowid);
    const face = (photoId: number, personId: number, quality: number) =>
      Number(
        db.run(
          `INSERT INTO faces (photo_id, person_id, x, y, w, h, quality, embedding)
        VALUES (?, ?, 0, 0, .5, .5, ?, zeroblob(512))`,
          [photoId, personId, quality],
        ).lastInsertRowid,
      );
    const publicFace = face(publicPhoto, a, 0.4);
    const privateFace = face(privatePhoto, a, 0.9);
    face(publicPhoto, b, 0.2);

    expect(personPhotos(a, "public")).toEqual([publicPhoto]);
    expect(personPhotos(b, "public")).toEqual([publicPhoto]);
    expect(setPersonCover(a, privatePhoto, "public")).toBe(false);
    expect(setPersonCover(a, publicPhoto, "public")).toBe(true);
    expect(namePerson(a, "Named group", "public")).toBe(true);
    expect(mergePeople(a, a, "public")).toBe(false);
    expect(mergePeople(a, b, "public")).toBe(true);
    expect(personPhotos(a, "all")).toBeNull();
    expect(personPhotos(b, "public")).toEqual([publicPhoto]);
    const first = { time: 10, yearOnly: true };
    const last = { time: 20, yearOnly: false };
    const summary = {
      id: b,
      name: "Named group",
      count: 1,
      coverId: publicFace,
      coverPhotoId: publicPhoto,
      first,
      last: first,
    };
    expect(listPeople("public").people).toEqual([summary]);
    expect(personDetail(b, "all")).toEqual({
      person: { ...summary, count: 2, last },
      ids: [publicPhoto, privatePhoto],
    });
    expect(setPersonCover(b, privatePhoto, "all")).toBe(true);
    expect(listPeople("all").people).toEqual([
      { ...summary, count: 2, coverId: privateFace, coverPhotoId: privatePhoto, last },
    ]);
    expect(listPeople("public").people).toEqual([summary]);
    expect(visibleFace(privateFace, "public")).toBeNull();
    db.run("UPDATE photos SET mtime = 2 WHERE id = ?", [publicPhoto]);
    expect(personPhotos(b, "public")).toBeNull();
    expect(visibleFace(publicFace, "all")).toBeNull();
  } finally {
    db.run("ROLLBACK TO people_test");
    db.run("RELEASE people_test");
  }
});
