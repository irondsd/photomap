import { db } from "./db";

export interface AlbumDate {
  time: number;
  yearOnly: boolean;
}

export interface AlbumSummary {
  id: number;
  name: string;
  count: number;
  coverId: number | null;
  first: AlbumDate | null;
  last: AlbumDate | null;
}

export interface AlbumCatalog {
  albums: AlbumSummary[];
  favorites: AlbumSummary & { ids: number[] };
}

export const FAVORITES_ID = 0;

// Match the gallery's treatment of file modification dates and unknown dates.
const taken = "CASE WHEN p.time_source IS NOT NULL AND p.time_source <> 'mtime' THEN p.taken_local END";

interface Member {
  albumId: number;
  id: number;
  time: number | null;
  source: string | null;
}

const memberDate = (m: Member): AlbumDate | null =>
  m.time == null ? null : { time: m.time, yearOnly: m.source === "folder" };

export function albumCatalog(): AlbumCatalog {
  const albums = db
    .query<{ id: number; name: string; cover_photo_id: number | null }, []>(
      "SELECT id, name, cover_photo_id FROM albums",
    )
    .all();
  const chosenCovers = new Map(albums.map((a) => [a.id, a.cover_photo_id]));
  const availableCovers = new Map<number, number>();
  // Only return IDs for Favorites. The individual album grids fetch their own memberships.
  const members = db
    .query<Member, []>(
      `
    SELECT ap.album_id AS albumId, p.id, ${taken} AS time, p.time_source AS source
    FROM album_photos ap JOIN photos p ON p.id = ap.photo_id WHERE p.missing = 0
    UNION ALL
    SELECT 0, p.id, ${taken}, p.time_source
    FROM favorites f JOIN photos p ON p.id = f.photo_id WHERE p.missing = 0
    ORDER BY 3, 2
  `,
    )
    .all();

  const summary = (id: number, name: string): AlbumSummary => ({
    id,
    name,
    count: 0,
    coverId: null,
    first: null,
    last: null,
  });
  const byId = new Map(albums.map(({ id, name }) => [id, summary(id, name)]));
  const favorites = { ...summary(FAVORITES_ID, "Favorites"), ids: [] as number[] };
  byId.set(FAVORITES_ID, favorites);
  for (const m of members) {
    const album = byId.get(m.albumId)!;
    if (chosenCovers.get(m.albumId) === m.id) availableCovers.set(m.albumId, m.id);
    const date = memberDate(m);
    if (album.coverId == null || (date && !album.first) || (date && m.albumId === FAVORITES_ID)) {
      album.coverId = m.id;
    }
    album.count++;
    if (date) {
      album.first ??= date;
      album.last = date;
    }
    if (m.albumId === FAVORITES_ID) favorites.ids.push(m.id);
  }
  for (const [albumId, photoId] of availableCovers) byId.get(albumId)!.coverId = photoId;
  const sorted = [...byId.values()]
    .filter((a) => a.id !== FAVORITES_ID)
    .sort(
      (a, b) =>
        (b.last?.time ?? -Infinity) - (a.last?.time ?? -Infinity) ||
        (b.first?.time ?? -Infinity) - (a.first?.time ?? -Infinity) ||
        b.id - a.id,
    );
  return { albums: sorted, favorites };
}

export const getAlbum = (id: number) =>
  db.query<{ id: number; name: string }, [number]>("SELECT id, name FROM albums WHERE id = ?").get(id);

export const albumPhotoIds = (id: number) =>
  db
    .query<{ id: number }, [number]>(
      `
    SELECT p.id FROM album_photos ap JOIN photos p ON p.id = ap.photo_id
    WHERE ap.album_id = ? AND p.missing = 0
  `,
    )
    .all(id)
    .map((p) => p.id);

export const photoAlbums = (id: number) =>
  db
    .query<{ id: number; name: string }, [number]>(
      `
    SELECT a.id, a.name FROM album_photos ap JOIN albums a ON a.id = ap.album_id
    WHERE ap.photo_id = ? ORDER BY a.name COLLATE NOCASE, a.id
  `,
    )
    .all(id);

const addMember = db.query(`
  INSERT OR IGNORE INTO album_photos (album_id, photo_id)
  SELECT ?, id FROM photos WHERE id = ? AND missing = 0
`);
const removeMember = db.query("DELETE FROM album_photos WHERE album_id = ? AND photo_id = ?");

export const changeAlbumMembers = db.transaction((albumId: number, ids: number[], remove = false) => {
  const statement = remove ? removeMember : addMember;
  for (const id of ids) statement.run(albumId, id);
  if (remove) {
    db.run(
      `
      UPDATE albums SET cover_photo_id = NULL WHERE id = ? AND cover_photo_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM album_photos WHERE album_id = albums.id AND photo_id = albums.cover_photo_id)
    `,
      [albumId],
    );
  }
});

export const setAlbumCover = (albumId: number, photoId: number) =>
  db.run(
    `
    UPDATE albums SET cover_photo_id = ? WHERE id = ? AND EXISTS (
      SELECT 1 FROM album_photos ap JOIN photos p ON p.id = ap.photo_id
      WHERE ap.album_id = albums.id AND ap.photo_id = ? AND p.missing = 0 AND p.kind <> 'video'
    )
  `,
    [photoId, albumId, photoId],
  ).changes > 0;

export const createAlbum = db.transaction((name: string, ids: number[]) => {
  const id = Number(db.run("INSERT INTO albums (name) VALUES (?)", [name]).lastInsertRowid);
  changeAlbumMembers(id, ids);
  return id;
});

export const renameAlbum = (id: number, name: string) =>
  db.run("UPDATE albums SET name = ? WHERE id = ?", [name, id]).changes > 0;

export const deleteAlbum = (id: number) => db.run("DELETE FROM albums WHERE id = ?", [id]).changes > 0;

export function setFavorite(id: number, favorite: boolean): boolean {
  return db.transaction(() => {
    const photo = db.query("SELECT 1 FROM photos WHERE id = ? AND missing = 0").get(id);
    if (!photo) return false;
    if (favorite) db.run("INSERT OR IGNORE INTO favorites (photo_id) VALUES (?)", [id]);
    else db.run("DELETE FROM favorites WHERE photo_id = ?", [id]);
    return true;
  })();
}
