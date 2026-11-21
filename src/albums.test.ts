import { expect, test } from "bun:test";
import { addRoot, db, deletePhoto, getPhoto, setPhotosPrivate, stats, touchPhoto } from "./db";
import {
  albumCatalog,
  albumPhotoIds,
  changeAlbumMembers,
  createAlbum,
  deleteAlbum,
  photoAlbums,
  setAlbumCover,
  setFavorite,
} from "./albums";

test("albums use capture dates and hide missing photos without losing their memberships", () => {
  // Roll back fixture rows so the shared test index stays unchanged.
  db.run("SAVEPOINT albums_test");
  try {
    const root = addRoot("/albums-test");
    const insert = (name: string, time: number, source: string) =>
      Number(
        db.run(
          `
      INSERT INTO photos (root_id, path, rel_dir, name, ext, kind, size, mtime, scan_gen, indexed_at, taken_local, time_source)
      VALUES (?, ?, '', ?, 'jpg', 'photo', 0, 0, 0, 0, ?, ?)
    `,
          [root.id, `${root.path}/${name}`, name, time, source],
        ).lastInsertRowid,
      );
    const first = insert("first.jpg", 10, "folder");
    const laterFirst = insert("later-first.jpg", 20, "exif");
    const last = insert("last.jpg", 30, "exif");
    const undated = insert("unknown.jpg", 1, "mtime");
    const broad = createAlbum("Long trip", [last, undated, first, first]);
    const narrow = createAlbum("Weekend", [last, laterFirst]);
    const empty = createAlbum("Empty", []);
    expect(albumCatalog().albums.map((a) => a.id)).toEqual([narrow, broad, empty]);
    const summary = albumCatalog().albums.find((a) => a.id === broad)!;
    expect(summary).toMatchObject({
      count: 3,
      coverId: first,
      first: { time: 10, yearOnly: true },
      last: { time: 30 },
    });

    const cover = () => albumCatalog().albums.find((a) => a.id === broad)!.coverId;
    expect(setAlbumCover(broad, laterFirst)).toBe(false);
    expect(setAlbumCover(broad, last)).toBe(true);
    expect(cover()).toBe(last);
    db.run("UPDATE photos SET missing = 1 WHERE id = ?", [last]);
    expect(cover()).toBe(first);
    db.run("UPDATE photos SET missing = 0 WHERE id = ?", [last]);
    expect(cover()).toBe(last);
    changeAlbumMembers(broad, [last], true);
    expect(cover()).toBe(first);
    changeAlbumMembers(broad, [last]);
    expect(cover()).toBe(first);

    expect(setFavorite(first, true)).toBe(true);
    expect(setFavorite(first, true)).toBe(true);
    expect(photoAlbums(last).map((a) => a.id)).toEqual([broad, narrow]);
    expect(albumCatalog().favorites.ids).toEqual([first]);

    db.run("UPDATE photos SET missing = 1 WHERE id = ?", [first]);
    expect(albumPhotoIds(broad)).not.toContain(first);
    expect(albumCatalog().favorites.ids).toEqual([]);
    db.run("UPDATE photos SET missing = 0 WHERE id = ?", [first]);
    expect(albumPhotoIds(broad)).toContain(first);
    expect(albumCatalog().favorites.ids).toEqual([first]);

    changeAlbumMembers(narrow, [last], true);
    expect(photoAlbums(last).map((a) => a.id)).toEqual([broad]);
    expect(getPhoto(last)).toBeTruthy();
    expect(deleteAlbum(broad)).toBe(true);
    expect(photoAlbums(first)).toEqual([]);
    expect(albumCatalog().favorites.ids).toEqual([first]);
    deletePhoto(first);
    expect(albumCatalog().favorites.ids).toEqual([]);
  } finally {
    db.run("ROLLBACK TO albums_test");
    db.run("RELEASE albums_test");
  }
});

test("private members disappear from normal browsing and return with their cover and favorite intact", () => {
  db.run("SAVEPOINT private_album_test");
  try {
    const root = addRoot("/private-album-test");
    const insert = (name: string, time: number) =>
      Number(
        db.run(
          `INSERT INTO photos (root_id, path, rel_dir, name, ext, kind, size, mtime, scan_gen, indexed_at, taken_local, time_source, lat, lon)
       VALUES (?, ?, '', ?, 'jpg', 'photo', 0, 0, 0, 0, ?, 'exif', 1, 1)`,
          [root.id, `${root.path}/${name}`, name, time],
        ).lastInsertRowid,
      );
    const visible = insert("visible.jpg", 10);
    const hidden = insert("hidden.jpg", 20);
    const trip = createAlbum("Trip", [visible, hidden]);
    setAlbumCover(trip, hidden);
    setFavorite(hidden, true);
    const publicCount = stats("public").geotagged;

    expect(setPhotosPrivate([hidden], true)).toEqual([hidden]);
    expect(setPhotosPrivate([hidden], true)).toEqual([]);
    touchPhoto(hidden, 1);
    expect(stats("public").geotagged).toBe(publicCount - 1);
    expect(stats("private").geotagged).toBe(1);
    expect(albumPhotoIds(trip)).toEqual([visible]);
    expect(albumPhotoIds(trip, "private")).toEqual([hidden]);
    expect(albumCatalog().favorites.ids).not.toContain(hidden);
    expect(albumCatalog().albums.find((album) => album.id === trip)).toMatchObject({
      count: 1,
      coverId: visible,
      last: { time: 10 },
    });
    expect(albumCatalog("all").favorites.ids).toContain(hidden);
    expect(albumCatalog("all").albums.find((album) => album.id === trip)).toMatchObject({ count: 2, coverId: hidden });

    expect(setPhotosPrivate([hidden], false)).toEqual([hidden]);
    expect(albumPhotoIds(trip)).toEqual([visible, hidden]);
    expect(albumCatalog().favorites.ids).toContain(hidden);
    expect(albumCatalog().albums.find((album) => album.id === trip)?.coverId).toBe(hidden);
  } finally {
    db.run("ROLLBACK TO private_album_test");
    db.run("RELEASE private_album_test");
  }
});
