import { Database } from 'bun:sqlite'
import { DB_PATH } from './config'

export interface PhotoRow {
  id: number
  root_id: number
  path: string
  rel_dir: string
  name: string
  ext: string
  kind: 'photo' | 'raw' | 'video'
  size: number
  mtime: number
  scan_gen: number
  missing: number
  /** Wall-clock time where the photo was taken, as seconds since epoch read as UTC. */
  taken_local: number | null
  /** Minutes east of UTC, when known. */
  tz_offset: number | null
  time_source: string | null
  lat: number | null
  lon: number | null
  alt: number | null
  gps_source: string | null
  width: number | null
  height: number | null
  orientation: number | null
  duration: number | null
  make: string | null
  model: string | null
  lens: string | null
  iso: number | null
  fnumber: number | null
  exposure: number | null
  focal: number | null
  country_code: string | null
  country: string | null
  error: string | null
  indexed_at: number
}

export type PhotoInsert = Omit<PhotoRow, 'id' | 'missing' | 'indexed_at'>

export interface RootRow {
  id: number
  path: string
  added_at: number
  last_scan_at: number | null
}

const SCHEMA_VERSION = 1

export const db = new Database(DB_PATH, { create: true })
db.run('PRAGMA journal_mode = WAL')
db.run('PRAGMA synchronous = NORMAL')
db.run('PRAGMA foreign_keys = ON')

db.run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`)
const version = Number(db.query<{ value: string }, []>(`SELECT value FROM meta WHERE key = 'schema'`).get()?.value ?? 0)

if (version < 1) {
  db.transaction(() => {
    db.run(`CREATE TABLE roots (
      id INTEGER PRIMARY KEY,
      path TEXT UNIQUE NOT NULL,
      added_at INTEGER NOT NULL,
      last_scan_at INTEGER
    )`)
    db.run(`CREATE TABLE photos (
      id INTEGER PRIMARY KEY,
      root_id INTEGER NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
      path TEXT UNIQUE NOT NULL,
      rel_dir TEXT NOT NULL,
      name TEXT NOT NULL,
      ext TEXT NOT NULL,
      kind TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime INTEGER NOT NULL,
      scan_gen INTEGER NOT NULL,
      missing INTEGER NOT NULL DEFAULT 0,
      taken_local REAL,
      tz_offset INTEGER,
      time_source TEXT,
      lat REAL, lon REAL, alt REAL,
      gps_source TEXT,
      width INTEGER, height INTEGER, orientation INTEGER, duration REAL,
      make TEXT, model TEXT, lens TEXT,
      iso INTEGER, fnumber REAL, exposure REAL, focal REAL,
      country_code TEXT, country TEXT,
      error TEXT,
      indexed_at INTEGER NOT NULL
    )`)
    db.run(`CREATE INDEX photos_taken ON photos(taken_local)`)
    db.run(`CREATE INDEX photos_root ON photos(root_id, scan_gen)`)
    db.run(`CREATE INDEX photos_geo ON photos(lat, lon)`)
    db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', '${SCHEMA_VERSION}')`)
  })()
}

const PHOTO_COLS = [
  'root_id',
  'path',
  'rel_dir',
  'name',
  'ext',
  'kind',
  'size',
  'mtime',
  'scan_gen',
  'taken_local',
  'tz_offset',
  'time_source',
  'lat',
  'lon',
  'alt',
  'gps_source',
  'width',
  'height',
  'orientation',
  'duration',
  'make',
  'model',
  'lens',
  'iso',
  'fnumber',
  'exposure',
  'focal',
  'country_code',
  'country',
  'error',
] as const satisfies readonly (keyof PhotoInsert)[]

const upsertStmt = db.prepare(
  `INSERT INTO photos (${PHOTO_COLS.join(', ')}, missing, indexed_at)
   VALUES (${PHOTO_COLS.map((c) => '$' + c).join(', ')}, 0, $indexed_at)
   ON CONFLICT(path) DO UPDATE SET
   ${PHOTO_COLS.filter((c) => c !== 'path')
     .map((c) => `${c} = excluded.${c}`)
     .join(', ')},
   missing = 0, indexed_at = excluded.indexed_at`,
)

export function upsertPhoto(p: PhotoInsert) {
  const params: Record<string, unknown> = { $indexed_at: Date.now() }
  for (const c of PHOTO_COLS) params['$' + c] = p[c] ?? null
  upsertStmt.run(params as any)
}

const touchStmt = db.prepare<void, [number, number]>(`UPDATE photos SET scan_gen = ?, missing = 0 WHERE id = ?`)
export const touchPhoto = (id: number, gen: number) => touchStmt.run(gen, id)

/** Flags files not seen by the scan. With `under`, only files inside that folder are considered. */
export function markMissing(rootId: number, gen: number, under?: string): number {
  if (under) {
    const prefix = under.endsWith('/') ? under : under + '/'
    return db.run(
      `UPDATE photos SET missing = 1 WHERE root_id = ? AND scan_gen < ? AND missing = 0 AND substr(path, 1, ?) = ?`,
      [rootId, gen, prefix.length, prefix],
    ).changes
  }
  return db.run(`UPDATE photos SET missing = 1 WHERE root_id = ? AND scan_gen < ? AND missing = 0`, [rootId, gen])
    .changes
}

/** Small key/value settings, e.g. which extractor version last read a root. */
export function getMeta(key: string): string | null {
  return db.query<{ value: string }, [string]>(`SELECT value FROM meta WHERE key = ?`).get(key)?.value ?? null
}
export function setMeta(key: string, value: string) {
  db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, [key, value])
}

export function nextScanGen(): number {
  const row = db.query<{ value: string }, []>(`SELECT value FROM meta WHERE key = 'scan_gen'`).get()
  const gen = Number(row?.value ?? 0) + 1
  db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES ('scan_gen', ?)`, [String(gen)])
  return gen
}

export interface KnownFile {
  id: number
  size: number
  mtime: number
  lat: number | null
  lon: number | null
  gps_source: string | null
  taken_local: number | null
  time_source: string | null
}

export function knownFiles(rootId: number): Map<string, KnownFile> {
  const rows = db
    .query<
      KnownFile & { path: string },
      [number]
    >(`SELECT id, path, size, mtime, lat, lon, gps_source, taken_local, time_source FROM photos WHERE root_id = ?`)
    .all(rootId)
  return new Map<string, KnownFile>(rows.map((r): [string, KnownFile] => [r.path, r]))
}

export const getRoots = () => db.query<RootRow, []>(`SELECT * FROM roots ORDER BY path`).all()
export const getRoot = (id: number) => db.query<RootRow, [number]>(`SELECT * FROM roots WHERE id = ?`).get(id)

export function addRoot(path: string): RootRow {
  db.run(`INSERT OR IGNORE INTO roots (path, added_at) VALUES (?, ?)`, [path, Date.now()])
  return db.query<RootRow, [string]>(`SELECT * FROM roots WHERE path = ?`).get(path)!
}

export const removeRoot = (id: number) => db.run(`DELETE FROM roots WHERE id = ?`, [id])
export const setRootScanned = (id: number) => db.run(`UPDATE roots SET last_scan_at = ? WHERE id = ?`, [Date.now(), id])

export const getPhoto = (id: number) => db.query<PhotoRow, [number]>(`SELECT * FROM photos WHERE id = ?`).get(id)

/** Compact columns used to build the client-side index. */
export function allPoints() {
  return db
    .query<
      { id: number; t: number | null; lat: number | null; lon: number | null; kind: string },
      []
    >(`SELECT id, taken_local AS t, lat, lon, kind FROM photos WHERE missing = 0`)
    .all()
}

export function stats() {
  const one = <T>(sql: string) => db.query<T, []>(sql).get()!
  const all = <T>(sql: string) => db.query<T, []>(sql).all()
  return {
    total: one<{ n: number }>(`SELECT count(*) n FROM photos WHERE missing = 0`).n,
    geotagged: one<{ n: number }>(`SELECT count(*) n FROM photos WHERE missing = 0 AND lat IS NOT NULL`).n,
    missing: one<{ n: number }>(`SELECT count(*) n FROM photos WHERE missing = 1`).n,
    errors: one<{ n: number }>(`SELECT count(*) n FROM photos WHERE missing = 0 AND error IS NOT NULL`).n,
    range: one<{ min: number | null; max: number | null }>(
      `SELECT min(taken_local) min, max(taken_local) max FROM photos WHERE missing = 0`,
    ),
    kinds: all<{ kind: string; n: number }>(
      `SELECT kind, count(*) n FROM photos WHERE missing = 0 GROUP BY kind ORDER BY n DESC`,
    ),
    timeSources: all<{ source: string | null; n: number }>(
      `SELECT time_source source, count(*) n FROM photos WHERE missing = 0 GROUP BY time_source ORDER BY n DESC`,
    ),
    countries: all<{ code: string; name: string; n: number }>(
      `SELECT country_code code, country name, count(*) n FROM photos
       WHERE missing = 0 AND country_code IS NOT NULL GROUP BY country_code ORDER BY n DESC`,
    ),
    cameras: all<{ make: string | null; model: string; n: number }>(
      `SELECT make, model, count(*) n FROM photos
       WHERE missing = 0 AND model IS NOT NULL GROUP BY make, model ORDER BY n DESC LIMIT 20`,
    ).map((c) => ({ model: cameraName(c.make, c.model), n: c.n })),
  }
}

export function cameraName(make: string | null, model: string | null): string | null {
  if (!model) return make
  if (!make) return model
  const brand = make.split(/\s+/)[0]!.toLowerCase()
  return model.toLowerCase().startsWith(brand) ? model : `${make} ${model}`
}
