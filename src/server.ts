import { join } from 'node:path'
import index from './frontend/index.html'
import { HOST, PORT, CPUS } from './config'
import { db, getPhoto, getRoot, getRoots, removeRoot, stats, cameraName, type RootRow } from './db'
import { registerTarget, type ScanTarget } from './scan/roots'
import { setLocation } from './scan/locate'
import { scanRoot, cancelScan, status as scanStatus } from './scan/scanner'
import { getThumb, hasThumb, pregenerateThumbs, thumbETag, type ThumbSize } from './thumbs'

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

/**
 * Column-oriented binary blob, sorted by time (undated last):
 *   u32 count, u32 pad | f64 t[n] | f32 lat[n] | f32 lon[n] | u32 id[n] | u8 kind[n]
 * Missing time/coords are NaN. ~21 bytes per photo.
 */
function encodePoints(): ArrayBuffer {
  const rows = db
    .query<{ id: number; t: number | null; lat: number | null; lon: number | null; kind: string }, []>(
      `SELECT id, taken_local t, lat, lon, kind FROM photos WHERE missing = 0
       ORDER BY taken_local IS NULL, taken_local, id`,
    )
    .all()
  const n = rows.length
  const buf = new ArrayBuffer(8 + n * (8 + 4 + 4 + 4 + 1))
  new Uint32Array(buf, 0, 2).set([n, 0])
  let off = 8
  const t = new Float64Array(buf, off, n)
  off += n * 8
  const lat = new Float32Array(buf, off, n)
  off += n * 4
  const lon = new Float32Array(buf, off, n)
  off += n * 4
  const id = new Uint32Array(buf, off, n)
  off += n * 4
  const kind = new Uint8Array(buf, off, n)
  for (let i = 0; i < n; i++) {
    const r = rows[i]!
    t[i] = r.t ?? NaN
    lat[i] = r.lat ?? NaN
    lon[i] = r.lon ?? NaN
    id[i] = r.id
    kind[i] = KIND_CODE[r.kind] ?? 0
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
  void pregenerateThumbs(undefined, Math.max(1, Math.floor(CPUS / 2)))
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

    // Locations set by hand. Photos whose file carries GPS can't be overridden.
    '/api/photos/:id/location': {
      POST: guard(async (req) => {
        const id = idParam(req.params.id)
        const p = id && getPhoto(id)
        if (!p) return bad('not found', 404)
        if (p.gps_source === 'exif' || p.gps_source === 'video') return bad('This photo has GPS data in the file', 409)
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
      DELETE: guard((req) => {
        const id = idParam(req.params.id)
        const p = id && getPhoto(id)
        if (!p) return bad('not found', 404)
        if (p.gps_source !== 'manual') return bad('Only locations added by hand can be removed', 409)
        setLocation(p.id, null)
        dataVersion = Date.now()
        const updated = getPhoto(p.id)!
        return json({ ...updated, camera: cameraName(updated.make, updated.model) })
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
        if ((size !== 's' && size !== 'l') || !id) return bad('bad request')
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
void pregenerateThumbs(undefined, Math.max(1, Math.floor(CPUS / 2)))
