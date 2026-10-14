import { join } from 'node:path'
import index from './frontend/index.html'
import { HOST, PORT, CPUS } from './config'
import { db, getPhoto, getRoot, getRoots, removeRoot, stats, cameraName, type RootRow } from './db'
import { registerTarget, type ScanTarget } from './scan/roots'
import { restoreFromFile, setLocation } from './scan/locate'
import { scanRoot, cancelScan, status as scanStatus } from './scan/scanner'
import { getThumb, hasThumb, pregenerateThumbs, thumbETag, THUMB_SIZES, type ThumbSize } from './thumbs'

/** Bumped whenever the index changes so the client knows to refetch points. */
let dataVersion = Date.now()

// SQLite's data_version changes when another connection (e.g. a CLI command) commits.
const dbVersionStmt = db.query<{ data_version: number }, []>('PRAGMA data_version')
const currentVersion = () => `${dataVersion}.${dbVersionStmt.get()!.data_version}`

// ---------------------------------------------------------------- security
// Only ever serve the local machine: reject foreign Host headers (DNS rebinding)
// and cross-site writes from pages open in the same browser.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

function forbidden(req: Request): boolean {
  const host = req.headers.get('host') ?? ''
  const hostname = host.replace(/:\d+$/, '')
  if (!LOCAL_HOSTS.has(hostname)) return true
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.get('origin')
    if (origin && origin !== `http://${host}`) return true
  }
  return false
}

type Handler<R extends Request> = (req: R) => Response | Promise<Response>
function guard<R extends Request>(h: Handler<R>): Handler<R> {
  return (req) => (forbidden(req) ? new Response('Forbidden', { status: 403 }) : h(req))
}

const json = (data: unknown, init?: ResponseInit) => Response.json(data, init)
const bad = (message: string, status = 400) => json({ error: message }, { status })

// ---------------------------------------------------------------- points
const KIND_CODE: Record<string, number> = { photo: 0, raw: 1, video: 2 }

/** Where a location came from: 0 none, 1 the file's own GPS, 2 inferred, 3 set by hand. */
function sourceCode(gps: string | null): number {
  if (gps == null) return 0
  if (gps === 'manual') return 3
  return gps.startsWith('inferred:') ? 2 : 1
}

/**
 * Column-oriented binary blob, sorted by time (undated last):
 *   u32 count, u32 jsonBytes | JSON country names, padded to 8 bytes
 *   | f64 t[n] | f32 lat[n] | f32 lon[n] | f32 aspect[n] | u32 id[n]
 *   | u16 country[n] (0 = none, else 1 + index into the names) | u8 kind[n] | u8 source[n]
 *   | u8 datePrecision[n] (0 exact, 1 estimated, 2 year only, 3 unknown)
 * Missing time/coords/aspect are NaN. ~30 bytes per photo.
 */
/** How far a photo's date can be trusted, from its time source. */
function datePrecision(ts: string | null): number {
  if (ts === 'mtime' || ts == null) return 3
  if (ts === 'folder') return 2
  if (ts === 'sequence' || ts === 'gps-date') return 1
  return 0
}

function encodePoints(): ArrayBuffer {
  const rows = db
    .query<
      { id: number; t: number | null; lat: number | null; lon: number | null; kind: string; w: number | null; h: number | null; country: string | null; gps: string | null; ts: string | null },
      []
    >(
      `SELECT id, taken_local t, lat, lon, kind, width w, height h, country, gps_source gps, time_source ts FROM photos WHERE missing = 0
       ORDER BY taken_local IS NULL, taken_local, id`,
    )
    .all()
  const n = rows.length
  const countries: string[] = []
  const countryIndex = new Map<string, number>()
  for (const r of rows) {
    if (r.country && !countryIndex.has(r.country)) {
      countries.push(r.country)
      countryIndex.set(r.country, countries.length)
    }
  }
  const json = new TextEncoder().encode(JSON.stringify(countries))
  const head = 8 + Math.ceil(json.length / 8) * 8
  const buf = new ArrayBuffer(head + n * (8 + 4 + 4 + 4 + 4 + 2 + 1 + 1 + 1))
  new Uint32Array(buf, 0, 2).set([n, json.length])
  new Uint8Array(buf, 8, json.length).set(json)
  let off = head
  const col = <T>(make: new (b: ArrayBuffer, o: number, l: number) => T, bytes: number): T => {
    const a = new make(buf, off, n)
    off += n * bytes
    return a
  }
  const t = col(Float64Array, 8)
  const lat = col(Float32Array, 4)
  const lon = col(Float32Array, 4)
  const aspect = col(Float32Array, 4)
  const id = col(Uint32Array, 4)
  const country = col(Uint16Array, 2)
  const kind = col(Uint8Array, 1)
  const source = col(Uint8Array, 1)
  const precision = col(Uint8Array, 1)
  for (let i = 0; i < n; i++) {
    const r = rows[i]!
    t[i] = r.t ?? NaN
    lat[i] = r.lat ?? NaN
    lon[i] = r.lon ?? NaN
    aspect[i] = r.w && r.h ? r.w / r.h : NaN
    id[i] = r.id
    country[i] = r.country ? countryIndex.get(r.country)! : 0
    kind[i] = KIND_CODE[r.kind] ?? 0
    source[i] = sourceCode(r.gps)
    precision[i] = datePrecision(r.ts)
  }
  return buf
}

// ---------------------------------------------------------------- scanning
let scanQueue: ScanTarget[] = []

async function runScans(targets: ScanTarget[]) {
  for (const t of targets) {
    if (!scanQueue.some((q) => q.root.id === t.root.id && q.subdir === t.subdir)) scanQueue.push(t)
  }
  if (scanStatus.running) return
  while (scanQueue.length) {
    const { root, subdir } = scanQueue.shift()!
    if (!getRoot(root.id)) continue
    await scanRoot(root, undefined, subdir)
    dataVersion = Date.now()
    if (scanStatus.phase === 'cancelled') {
      scanQueue = []
      break
    }
  }
  // Background thumbnails at half capacity, leaving room for on-demand requests.
  if (!process.env.PHOTOMAP_NO_PREGEN) void pregenerateThumbs(undefined, Math.max(1, Math.floor(CPUS / 2)))
}

// ---------------------------------------------------------------- files
const VIDEO_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/mp4', // Chrome won't play video/quicktime even when the codec is fine
  '3gp': 'video/3gpp',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
}

function serveFile(path: string, ext: string, req: Request): Response {
  const file = Bun.file(path)
  const type = VIDEO_MIME[ext] ?? (file.type || 'application/octet-stream')
  const size = file.size
  const range = req.headers.get('range')
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range)
  if (m) {
    let start = m[1] ? Number(m[1]) : NaN
    let end = m[2] ? Number(m[2]) : size - 1
    if (Number.isNaN(start)) {
      start = Math.max(0, size - end) // suffix range: last N bytes
      end = size - 1
    }
    end = Math.min(end, size - 1)
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } })
    }
    return new Response(file.slice(start, end + 1), {
      status: 206,
      headers: {
        'content-type': type,
        'content-range': `bytes ${start}-${end}/${size}`,
        'content-length': String(end - start + 1),
        'accept-ranges': 'bytes',
      },
    })
  }
  return new Response(file, {
    headers: { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': String(size) },
  })
}

const VENDOR_DIR = join(import.meta.dir, '..', 'node_modules', 'maplibre-gl', 'dist')
const VENDOR_FILES = new Set(['maplibre-gl-worker.mjs', 'maplibre-gl-worker.mjs.map'])

// The cluster worker is bundled separately (HTML imports only bundle the page), on first request.
let workerJs: Promise<string> | null = null
function clusterWorker(): Promise<string> {
  workerJs ??= Bun.build({
    entrypoints: [join(import.meta.dir, 'frontend', 'cluster.worker.ts')],
    target: 'browser',
    minify: process.env.NODE_ENV === 'production',
  }).then((r) => {
    if (!r.success) {
      workerJs = null
      throw new AggregateError(r.logs, 'cluster worker build failed')
    }
    return r.outputs[0]!.text()
  })
  return workerJs
}

/** A JSON list of photo ids, deduplicated; null when malformed or empty. */
function parseIds(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > 200_000) return null
  const ids = [...new Set(v.map(Number))]
  return ids.every((n) => Number.isInteger(n) && n > 0) ? ids : null
}

const idParam = (s: string) => {
  const n = Number(s)
  return Number.isInteger(n) && n > 0 ? n : null
}

// ---------------------------------------------------------------- server
const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  development: process.env.NODE_ENV !== 'production' && { hmr: true, console: true },
  routes: {
    '/': index,

    '/api/points': {
      GET: guard(
        () =>
          new Response(encodePoints(), {
            headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' },
          }),
      ),
    },

    '/api/stats': { GET: guard(() => json({ ...stats(), version: currentVersion() })) },

    '/api/photos/:id': {
      GET: guard((req) => {
        const id = idParam(req.params.id)
        const p = id && getPhoto(id)
        if (!p) return bad('not found', 404)
        return json({ ...p, camera: cameraName(p.make, p.model) })
      }),
    },

    // Locations set by hand; they take precedence over the file's own GPS.
    '/api/photos/:id/location': {
      POST: guard(async (req) => {
        const id = idParam(req.params.id)
        const p = id && getPhoto(id)
        if (!p) return bad('not found', 404)
        // Allowed even when the file has GPS: those are sometimes plainly wrong.
        const body = (await req.json().catch(() => null)) as { lat?: unknown; lon?: unknown } | null
        const lat = Number(body?.lat)
        const lon = Number(body?.lon)
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
          return bad('lat and lon must be valid coordinates')
        }
        setLocation(p.id, { lat, lon, source: 'manual' })
        dataVersion = Date.now()
        const updated = getPhoto(p.id)!
        return json({ ...updated, camera: cameraName(updated.make, updated.model) })
      }),
      // Undo a hand-set location: back to whatever the file says (its own GPS, or none).
      DELETE: guard(async (req) => {
        const id = idParam(req.params.id)
        const p = id && getPhoto(id)
        if (!p) return bad('not found', 404)
        if (p.gps_source !== 'manual') return bad('Only locations set by hand can be reset', 409)
        if (p.missing) return bad('The file is no longer on disk', 409)
        await restoreFromFile(p.id)
        dataVersion = Date.now()
        const updated = getPhoto(p.id)!
        return json({ ...updated, camera: cameraName(updated.make, updated.model) })
      }),
    },

    // The same for many photos at once (gallery selection).
    '/api/locations': {
      POST: guard(async (req) => {
        const body = (await req.json().catch(() => null)) as { ids?: unknown; lat?: unknown; lon?: unknown } | null
        const ids = parseIds(body?.ids)
        const lat = Number(body?.lat)
        const lon = Number(body?.lon)
        if (!ids) return bad('ids must be a non-empty list of photo ids')
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
          return bad('lat and lon must be valid coordinates')
        }
        let changed = 0
        db.transaction(() => {
          for (const id of ids) {
            if (!getPhoto(id)) continue
            setLocation(id, { lat, lon, source: 'manual' })
            changed++
          }
        })()
        dataVersion = Date.now()
        return json({ changed })
      }),
    },

    '/api/locations/reset': {
      POST: guard(async (req) => {
        const body = (await req.json().catch(() => null)) as { ids?: unknown } | null
        const ids = parseIds(body?.ids)
        if (!ids) return bad('ids must be a non-empty list of photo ids')
        let reset = 0
        for (const id of ids) {
          const p = getPhoto(id)
          if (!p || p.gps_source !== 'manual' || p.missing) continue
          await restoreFromFile(id)
          reset++
        }
        dataVersion = Date.now()
        return json({ reset })
      }),
    },

    '/api/roots': {
      GET: guard(() => json(getRoots())),
      POST: guard(async (req) => {
        const body = (await req.json().catch(() => null)) as { path?: unknown } | null
        if (typeof body?.path !== 'string' || !body.path.trim()) return bad('path required')
        try {
          const target = registerTarget(body.path.trim())
          void runScans([target])
          return json(target.root)
        } catch (err) {
          return bad((err as Error).message)
        }
      }),
    },

    '/api/roots/:id': {
      DELETE: guard((req) => {
        const id = idParam(req.params.id)
        if (!id) return bad('bad id')
        if (scanStatus.running && scanStatus.root === getRoot(id)?.path) return bad('folder is being scanned', 409)
        removeRoot(id)
        dataVersion = Date.now()
        return json({ ok: true })
      }),
    },

    '/api/scan': {
      GET: guard(() => json({ ...scanStatus, queued: scanQueue.length, version: currentVersion() })),
      POST: guard(async (req) => {
        const body = (await req.json().catch(() => ({}))) as { rootId?: number }
        const roots = body.rootId ? [getRoot(body.rootId)].filter((r): r is RootRow => !!r) : getRoots()
        if (!roots.length) return bad('no folders to scan')
        void runScans(roots.map((root) => ({ root, subdir: null })))
        return json({ ok: true })
      }),
      DELETE: guard(() => {
        cancelScan()
        return json({ ok: true })
      }),
    },

    '/api/reveal/:id': {
      POST: guard((req) => {
        const id = idParam(req.params.id)
        const p = id && getPhoto(id)
        if (!p) return bad('not found', 404)
        const cmd =
          process.platform === 'darwin'
            ? ['open', '-R', p.path]
            : process.platform === 'win32'
              ? ['explorer.exe', `/select,${p.path}`]
              : ['xdg-open', join(p.path, '..')]
        Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore' })
        return json({ ok: true })
      }),
    },

    // Renamed from /thumb/, whose responses were cached as immutable and can be stale.
    '/thumbs/:size/:id': {
      GET: guard(async (req) => {
        const size = req.params.size as ThumbSize
        const id = idParam(req.params.id)
        if (!THUMB_SIZES.includes(size) || !id) return bad('bad request')
        const p = getPhoto(id)
        if (!p) return bad('not found', 404)
        // Revalidated on every use: a 304 costs nothing locally, and ids aren't stable forever.
        const headers = { etag: thumbETag(p, size), 'cache-control': 'private, no-cache' }
        if (req.headers.get('if-none-match') === headers.etag && hasThumb(p, size)) {
          return new Response(null, { status: 304, headers })
        }
        const file = await getThumb(p, size)
        if (!file) return new Response('cannot decode', { status: 415 })
        return new Response(Bun.file(file), { headers: { ...headers, 'content-type': 'image/jpeg' } })
      }),
    },

    // Only files present in the index are ever served.
    '/original/:id': {
      GET: guard((req) => {
        const id = idParam(req.params.id)
        const p = id && getPhoto(id)
        if (!p || p.missing) return bad('not found', 404)
        const res = serveFile(p.path, p.ext, req)
        res.headers.set('cache-control', 'private, no-cache')
        return res
      }),
    },

    '/vendor/:file': {
      GET: guard((req) => {
        if (!VENDOR_FILES.has(req.params.file)) return bad('not found', 404)
        return new Response(Bun.file(join(VENDOR_DIR, req.params.file)), {
          headers: { 'content-type': 'text/javascript', 'cache-control': 'max-age=86400' },
        })
      }),
    },

    '/worker/cluster.js': {
      GET: guard(
        async () =>
          new Response(await clusterWorker(), {
            headers: { 'content-type': 'text/javascript', 'cache-control': 'no-cache' },
          }),
      ),
    },
  },
  fetch() {
    return new Response('Not found', { status: 404 })
  },
})

console.log(`Photomap running at http://localhost:${server.port}`)

// Catch up on thumbnails a previous run (or a CLI scan) didn't generate.
if (!process.env.PHOTOMAP_NO_PREGEN) void pregenerateThumbs(undefined, Math.max(1, Math.floor(CPUS / 2)))
