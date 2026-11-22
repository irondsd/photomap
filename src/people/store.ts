import { db, photoVisibilityFilter } from "../db";
import { collectionTaken, memberDate, type AlbumDate } from "../albums";
import type { PhotoVisibility } from "../photo-visibility";
import type { FaceBox } from "./images";

export interface PersonSummary {
  id: number;
  name: string | null;
  hidden: boolean;
  count: number;
  coverId: number;
  coverPhotoId: number;
  first: AlbumDate | null;
  last: AlbumDate | null;
}

export interface PersonDetail {
  person: PersonSummary;
  ids: number[];
}

export interface PeopleCatalog {
  people: PersonSummary[];
  hiddenPeople: PersonSummary[];
  scanned: number;
  failed: number;
  total: number;
}

export function initPeople() {
  db.transaction(() => {
    db.run(`CREATE TABLE IF NOT EXISTS people (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT
    );
    CREATE TABLE IF NOT EXISTS person_covers (
      person_id INTEGER PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
      photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS hidden_people (
      person_id INTEGER PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS face_scans (
      photo_id INTEGER PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL,
      failed INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS faces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      photo_id INTEGER NOT NULL REFERENCES face_scans(photo_id) ON DELETE CASCADE,
      person_id INTEGER NOT NULL REFERENCES people(id),
      x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL,
      quality REAL NOT NULL,
      embedding BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS faces_photo ON faces(photo_id);
    CREATE INDEX IF NOT EXISTS faces_person ON faces(person_id);`);
  }).immediate();
}

export const hasPeople = () =>
  db.query("SELECT 1 FROM sqlite_schema WHERE name = 'faces' AND type = 'table'").get() != null;

// Serve only current results. Changing a file invalidates its old boxes and matches.
export const currentScan = "s.photo_id = p.id AND s.mtime = p.mtime AND s.size = p.size";
export const pendingFacePhotos = `FROM photos p LEFT JOIN face_scans s ON ${currentScan}
  WHERE p.missing = 0 AND p.kind IN ('photo', 'raw')`;
export const facePhotos = `FROM faces f JOIN face_scans s ON s.photo_id = f.photo_id
  JOIN photos p ON ${currentScan} WHERE p.missing = 0`;

function summaries(visibility: PhotoVisibility, id?: number): PersonSummary[] {
  const scope = photoVisibilityFilter(visibility, "p");
  const members = db
    .query<
      {
        id: number;
        name: string | null;
        hidden: number;
        faceId: number;
        photoId: number;
        quality: number;
        chosenPhoto: number | null;
        time: number | null;
        source: string | null;
      },
      number[]
    >(
      `SELECT f.person_id id, g.name, h.person_id IS NOT NULL AS hidden, f.id faceId, f.photo_id photoId, f.quality,
    c.photo_id chosenPhoto, ${collectionTaken} AS time, p.time_source AS source
    FROM faces f JOIN face_scans s ON s.photo_id = f.photo_id JOIN photos p ON ${currentScan}
    JOIN people g ON g.id = f.person_id LEFT JOIN person_covers c ON c.person_id = g.id
    LEFT JOIN hidden_people h ON h.person_id = g.id
    WHERE p.missing = 0${scope}${id == null ? "" : " AND f.person_id = ?"}
    ORDER BY f.person_id, time, f.photo_id`,
    )
    .all(...(id == null ? [] : [id]));
  const people: PersonSummary[] = [];
  let group: PersonSummary | undefined;
  let previousPhoto = 0;
  let bestQuality = -Infinity;
  let bestChosen = false;
  for (const member of members) {
    if (group?.id !== member.id) {
      group = {
        id: member.id,
        name: member.name,
        hidden: Boolean(member.hidden),
        count: 0,
        coverId: member.faceId,
        coverPhotoId: member.photoId,
        first: null,
        last: null,
      };
      people.push(group);
      previousPhoto = 0;
      bestQuality = -Infinity;
      bestChosen = false;
    }
    if (previousPhoto !== member.photoId) {
      group.count++;
      previousPhoto = member.photoId;
      const date = memberDate(member);
      if (date) {
        group.first ??= date;
        group.last = date;
      }
    }
    const chosen = member.photoId === member.chosenPhoto;
    if (
      (chosen && !bestChosen) ||
      (chosen === bestChosen &&
        (member.quality > bestQuality || (member.quality === bestQuality && member.faceId < group.coverId)))
    ) {
      bestChosen = chosen;
      bestQuality = member.quality;
      group.coverId = member.faceId;
      group.coverPhotoId = member.photoId;
    }
  }
  return people.sort((a, b) => b.count - a.count || a.id - b.id);
}

export function listPeople(visibility: PhotoVisibility): PeopleCatalog {
  const scope = photoVisibilityFilter(visibility, "p");
  const total = db
    .query<{ n: number }, []>(
      `SELECT count(*) n FROM photos p WHERE p.missing = 0 AND p.kind IN ('photo', 'raw')${scope}`,
    )
    .get()!.n;
  if (!hasPeople()) return { people: [], hiddenPeople: [], scanned: 0, failed: 0, total };
  const groups = summaries(visibility);
  const { scanned, failed } = db
    .query<{ scanned: number; failed: number }, []>(
      `SELECT count(*) - coalesce(sum(s.failed), 0) scanned, coalesce(sum(s.failed), 0) failed
      FROM face_scans s JOIN photos p ON ${currentScan} WHERE p.missing = 0${scope}`,
    )
    .get()!;
  return {
    people: groups.filter((group) => !group.hidden),
    hiddenPeople: groups.filter((group) => group.hidden),
    total,
    scanned,
    failed,
  };
}

export function personPhotos(id: number, visibility: PhotoVisibility): number[] | null {
  if (!hasPeople()) return null;
  const photos = db
    .query<{ id: number }, [number]>(
      `SELECT DISTINCT p.id ${facePhotos} AND f.person_id = ?${photoVisibilityFilter(visibility, "p")}`,
    )
    .all(id);
  return photos.length ? photos.map((photo) => photo.id) : null;
}

export const personDetail = db.transaction((id: number, visibility: PhotoVisibility): PersonDetail | null => {
  const ids = personPhotos(id, visibility);
  if (!ids) return null;
  return { person: summaries(visibility, id)[0]!, ids };
});

export const setPersonCover = db.transaction((id: number, photoId: number, visibility: PhotoVisibility) => {
  if (!hasPeople()) return false;
  return (
    db.run(
      `INSERT INTO person_covers (person_id, photo_id)
    SELECT f.person_id, f.photo_id ${facePhotos} AND f.person_id = ? AND f.photo_id = ?
    ${photoVisibilityFilter(visibility, "p")} LIMIT 1
    ON CONFLICT(person_id) DO UPDATE SET photo_id = excluded.photo_id`,
      [id, photoId],
    ).changes > 0
  );
});

export function visibleFace(id: number, visibility: PhotoVisibility) {
  if (!hasPeople()) return null;
  return db
    .query<FaceBox & { photoId: number }, [number]>(
      `SELECT f.x, f.y, f.w, f.h, p.id photoId ${facePhotos} AND f.id = ?${photoVisibilityFilter(visibility, "p")}`,
    )
    .get(id);
}

export const namePerson = db.transaction(
  (id: number, name: string | null, visibility: PhotoVisibility) =>
    personPhotos(id, visibility) != null && db.run("UPDATE people SET name = ? WHERE id = ?", [name, id]).changes > 0,
);

export const setPersonHidden = db.transaction((id: number, hidden: boolean, visibility: PhotoVisibility) => {
  if (!personPhotos(id, visibility)) return false;
  if (hidden) db.run("INSERT OR IGNORE INTO hidden_people (person_id) VALUES (?)", [id]);
  else db.run("DELETE FROM hidden_people WHERE person_id = ?", [id]);
  return true;
});

function mergePersonInto(source: number, target: number) {
  db.run("UPDATE people SET name = coalesce(name, (SELECT name FROM people WHERE id = ?)) WHERE id = ?", [
    source,
    target,
  ]);
  db.run("UPDATE faces SET person_id = ? WHERE person_id = ?", [target, source]);
  db.run("INSERT OR IGNORE INTO person_covers SELECT ?, photo_id FROM person_covers WHERE person_id = ?", [
    target,
    source,
  ]);
  db.run("DELETE FROM people WHERE id = ?", [source]);
}

export const mergePeople = db.transaction((source: number, target: number, visibility: PhotoVisibility) => {
  if (source === target || !personPhotos(source, visibility) || !personPhotos(target, visibility)) return false;
  mergePersonInto(source, target);
  return true;
});

export const bulkEditPeople = db.transaction((ids: number[], target: number | null, visibility: PhotoVisibility) => {
  if (!hasPeople()) return false;
  const visibleGroup = db.query<{ name: string | null }, [number]>(`SELECT g.name FROM people g
    WHERE g.id = ? AND NOT EXISTS (SELECT 1 FROM hidden_people h WHERE h.person_id = g.id)
    AND EXISTS (SELECT 1 ${facePhotos} AND f.person_id = g.id${photoVisibilityFilter(visibility, "p")})`);
  const sources = [...new Set(ids)].filter((id) => id !== target);
  if (!sources.length || (target != null && !visibleGroup.get(target))) return false;
  if (sources.some((id) => visibleGroup.get(id)?.name !== null)) return false;

  // Validate every group before changing any. The immediate transaction also serializes with imports and single edits.
  const hide = db.query("INSERT INTO hidden_people (person_id) VALUES (?)");
  for (const id of sources) {
    if (target == null) hide.run(id);
    else mergePersonInto(id, target);
  }
  return true;
});

export interface PhotoPerson {
  id: number;
  name: string | null;
  /** This photo's face of the person, for a portrait cropped from this very photo. */
  faceId: number;
}

/** Recognized, non-hidden people in one photo, named ones first. */
export function photoPeople(photoId: number): PhotoPerson[] {
  if (!hasPeople()) return [];
  return db
    .query<PhotoPerson, [number]>(
      `SELECT g.id, g.name, min(f.id) faceId FROM faces f JOIN face_scans s ON s.photo_id = f.photo_id
      JOIN photos p ON ${currentScan} JOIN people g ON g.id = f.person_id
      WHERE p.missing = 0 AND p.id = ?
      AND NOT EXISTS (SELECT 1 FROM hidden_people h WHERE h.person_id = g.id)
      GROUP BY g.id ORDER BY g.name IS NULL, g.name COLLATE NOCASE, min(f.x)`,
    )
    .all(photoId);
}
