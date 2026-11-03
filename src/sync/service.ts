import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { renderSVG } from "uqr";
import { DEFAULT_SYNC_DIR, SYNC_PORT } from "../config";
import { getMeta, setMeta } from "../db";
import { dockerFolders, folderProblem, inDocker, syncDir, syncLayout } from "./folder";
import { PROTOCOL_VERSION, type HelloResponse, type PairingPayload } from "./protocol";
import { missingItems, parseManifest, parseUpload, receive, syncedCount, UploadError } from "./receive";

const TOKEN_KEY = "sync_token";
const ENABLED_KEY = "sync_enabled";

/** Uploads stop arriving for this long before the sync folder is rescanned. */
const SCAN_DELAY_MS = 8_000;

const serverName = () =>
  process.env.PHOTOMAP_SYNC_NAME || (inDocker ? "Photomap" : hostname().replace(/\.local$/, "")) || "Photomap";

export function pairingToken(): string {
  let t = getMeta(TOKEN_KEY);
  if (!t) {
    t = randomBytes(24).toString("base64url");
    setMeta(TOKEN_KEY, t);
  }
  return t;
}

/** Forgets every paired phone: they'll need to scan the new code. */
export function resetToken() {
  setMeta(TOKEN_KEY, randomBytes(24).toString("base64url"));
}

export function authorized(req: Request, expected = pairingToken()): boolean {
  const header = req.headers.get("authorization") ?? "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
}

/**
 * The addresses a phone on the same network could use, best first. Private IPv4 only:
 * wifi and ethernet before anything that looks like a VPN or a VM bridge.
 */
export function lanAddresses(interfaces = networkInterfaces()): string[] {
  const found: { address: string; rank: number }[] = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) continue;
      const rank = /^(en|eth|wlan|wl)/.test(name) ? 0 : /^(bridge|docker|veth|vmnet|utun|tun|tap)/.test(name) ? 2 : 1;
      found.push({ address: a.address, rank });
    }
  }
  return found.sort((a, b) => a.rank - b.rank).map((f) => f.address);
}

/** The URL to put in the pairing code, or null when this machine's LAN address can't be told. */
export function syncUrl(): string | null {
  if (process.env.PHOTOMAP_SYNC_URL) return process.env.PHOTOMAP_SYNC_URL.replace(/\/+$/, "");
  // Inside a container the interfaces are the container's own, which the phone can't reach.
  if (inDocker) return null;
  const address = lanAddresses()[0];
  return address ? `http://${address}:${SYNC_PORT}` : null;
}

// ---------------------------------------------------------------- sync API (on the LAN listener)

const json = (data: unknown, init?: ResponseInit) => Response.json(data, init);
const bad = (message: string, status = 400) => json({ error: message }, { status });

let scanTimer: ReturnType<typeof setTimeout> | null = null;

export function handleSync(req: Request, onReceived: () => void): Response | Promise<Response> {
  const { pathname } = new URL(req.url);
  if (!pathname.startsWith("/api/sync/")) return bad("not found", 404);
  if (!authorized(req)) return bad("This phone isn't paired with Photomap", 401);

  if (pathname === "/api/sync/hello" && req.method === "GET") {
    return json({ name: serverName(), protocol: PROTOCOL_VERSION } satisfies HelloResponse);
  }

  // Before the phone lists or sends anything, so it reports the problem instead of failing every file.
  const problem = (pathname === "/api/sync/check" || pathname === "/api/sync/file") && folderProblem();
  if (problem) return bad(`Photomap can't save files: ${problem}`, 503);

  if (pathname === "/api/sync/check" && req.method === "POST") {
    return req
      .json()
      .catch(() => null)
      .then((body) => {
        const items = parseManifest(body);
        return typeof items === "string" ? bad(items) : json({ missing: missingItems(items) });
      });
  }

  if (pathname === "/api/sync/file" && req.method === "PUT") {
    const upload = parseUpload(req.headers);
    if (typeof upload === "string") return bad(upload);
    const length = req.headers.get("content-length");
    return receive(syncDir(), upload, req.body, length ? Number(length) : null, syncLayout()).then(
      ({ path, created }) => {
        if (created) {
          if (scanTimer) clearTimeout(scanTimer);
          scanTimer = setTimeout(onReceived, SCAN_DELAY_MS);
        }
        return json({ path });
      },
      (e) => {
        if (e instanceof UploadError) return bad(e.message, e.status);
        console.error("sync upload failed:", e);
        return bad(`Couldn't save ${upload.filename}: ${(e as Error).message}`, 500);
      },
    );
  }

  return bad("not found", 404);
}

// ---------------------------------------------------------------- listener

let listener: ReturnType<typeof Bun.serve> | null = null;
let listenError: string | null = null;

export function startSync(onReceived: () => void) {
  setMeta(ENABLED_KEY, "1");
  if (listener) return;
  try {
    // In Docker an unshared folder would be created inside the container, so leave that to the check above.
    if (!folderProblem()) mkdirSync(syncDir(), { recursive: true });
    listener = Bun.serve({
      hostname: "0.0.0.0",
      port: SYNC_PORT,
      // Phone videos run to several GB; the body is streamed to disk, never held in memory.
      maxRequestBodySize: 64 * 1024 ** 3,
      idleTimeout: 120,
      fetch: (req) => handleSync(req, onReceived),
    });
    listenError = null;
    console.log(`Phone sync listening on port ${SYNC_PORT}, saving to ${syncDir()}`);
  } catch (e) {
    listenError = (e as Error).message;
    console.error("Phone sync couldn't start:", listenError);
  }
}

export function stopSync() {
  setMeta(ENABLED_KEY, "0");
  void listener?.stop();
  listener = null;
  listenError = null;
}

/** Turns sync back on at startup if it was on when the server last ran. */
export function resumeSync(onReceived: () => void) {
  if (getMeta(ENABLED_KEY) === "1") startSync(onReceived);
}

/** What the Sync section of the Library shows. */
export function syncStatus() {
  const enabled = getMeta(ENABLED_KEY) === "1";
  const url = syncUrl();
  const payload: PairingPayload | null = url
    ? { v: PROTOCOL_VERSION, url, token: pairingToken(), name: serverName() }
    : null;
  const qr = enabled && listener && payload ? renderSVG(JSON.stringify(payload), { border: 2 }) : null;
  return {
    enabled,
    listening: listener !== null,
    error: listenError,
    url,
    port: SYNC_PORT,
    folder: syncDir(),
    layout: syncLayout(),
    folderError: folderProblem(),
    defaultFolder: DEFAULT_SYNC_DIR,
    /** In Docker, the shared folders a sync folder can go in. */
    dockerFolders: dockerFolders(),
    inDocker,
    qr,
    ...syncedCount(),
  };
}
