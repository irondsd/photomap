import { db, photoVisibilityFilter } from "../db";
import type { PhotoVisibility } from "../photo-visibility";
import type { FaceBox } from "./images";

export interface PersonSummary {
  id: number;
  name: string | null;
  count: number;
  coverId: number;
}

export interface PeopleCatalog {
  people: PersonSummary[];
  scanned: number;
  failed: number;
  total: number;
}

// Only the explicit detection command creates these tables.
export function initPeople() {
  db.transaction(() => {
    db.run(`CREATE TABLE IF NOT EXISTS people (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT
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

const available = () => db.query("SELECT 1 FROM sqlite_schema WHERE name = 'faces' AND type = 'table'").get() != null;

// Serve only current results. Changing a file invalidates its old boxes and matches.
export const currentScan = "s.photo_id = p.id AND s.mtime = p.mtime AND s.size = p.size";
export const facePhotos = `FROM faces f JOIN face_scans s ON s.photo_id = f.photo_id
  JOIN photos p ON ${currentScan} WHERE p.missing = 0`;

export function listPeople(visibility: PhotoVisibility): PeopleCatalog {
  const scope = photoVisibilityFilter(visibility, "p");
  const total = db
    .query<{ n: number }, []>(
      `SELECT count(*) n FROM photos p WHERE p.missing = 0 AND p.kind IN ('photo', 'raw')${scope}`,
    )
    .get()!.n;
  if (!available()) return { people: [], scanned: 0, failed: 0, total };
  const people = db
    .query<PersonSummary, []>(
      `WITH visible AS (
    SELECT f.id AS coverId, f.person_id, f.photo_id,
      row_number() OVER (PARTITION BY f.person_id ORDER BY f.quality DESC, f.id) AS rank
    ${facePhotos}${scope}
  )
  SELECT people.id, people.name, count(DISTINCT v.photo_id) count,
    max(CASE WHEN v.rank = 1 THEN v.coverId END) coverId
  FROM visible v JOIN people ON people.id = v.person_id GROUP BY people.id
  ORDER BY count DESC, people.id`,
    )
    .all();
  const { scanned, failed } = db
    .query<{ scanned: number; failed: number }, []>(
      `SELECT count(*) - coalesce(sum(s.failed), 0) scanned, coalesce(sum(s.failed), 0) failed
      FROM face_scans s JOIN photos p ON ${currentScan} WHERE p.missing = 0${scope}`,
    )
    .get()!;
  return { people, total, scanned, failed };
}

export function personPhotos(id: number, visibility: PhotoVisibility): number[] | null {
  if (!available()) return null;
  const photos = db
    .query<{ id: number }, [number]>(
      `SELECT DISTINCT p.id ${facePhotos} AND f.person_id = ?${photoVisibilityFilter(visibility, "p")}`,
    )
    .all(id);
  return photos.length ? photos.map((photo) => photo.id) : null;
}

export function visibleFace(id: number, visibility: PhotoVisibility) {
  if (!available()) return null;
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

export const mergePeople = db.transaction((source: number, target: number, visibility: PhotoVisibility) => {
  if (source === target || !personPhotos(source, visibility) || !personPhotos(target, visibility)) return false;
  db.run("UPDATE people SET name = coalesce(name, (SELECT name FROM people WHERE id = ?)) WHERE id = ?", [
    source,
    target,
  ]);
  db.run("UPDATE faces SET person_id = ? WHERE person_id = ?", [target, source]);
  db.run("DELETE FROM people WHERE id = ?", [source]);
  return true;
});
