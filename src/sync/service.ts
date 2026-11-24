import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { renderSVG } from "uqr";
import { DEFAULT_SYNC_DIR, SYNC_PORT } from "../config";
import { getMeta, setMeta } from "../db";
import { normalizeFolder } from "../scan/roots";
import { dockerFolders, folderProblem, inDocker, syncDir, syncLayout } from "./folder";
import { PROTOCOL_VERSION, type HelloResponse, type PairingPayload, type WebCodeResponse } from "./protocol";
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
  if (pathname === WEB_OPEN_PATH) return openWeb(req);
  if (!pathname.startsWith("/api/sync/")) {
    if (phoneSession(req)) return proxyWeb(req);
    console.log(`Phone web: ${req.method} ${pathname} refused, not signed in (${browser(req)})`);
    return notSignedIn();
  }
  if (!authorized(req)) return bad("This phone isn't paired with Photomap", 401);

  if (pathname === "/api/sync/hello" && req.method === "GET") {
    return json({ name: serverName(), protocol: PROTOCOL_VERSION } satisfies HelloResponse);
  }

  if (pathname === "/api/sync/web-code" && req.method === "POST") {
    console.log("Phone asked for a link to the web app");
    return json({ path: `${WEB_OPEN_PATH}?code=${issueWebCode()}` } satisfies WebCodeResponse, { headers: noStore });
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

// ---------------------------------------------------------------- the web app, for paired phones
//
// A paired phone can open the full web app on this listener. The app asks for a one-time code with
// its token (POST /api/sync/web-code) and opens WEB_OPEN_PATH?code=… in a browser, which swaps the
// code for a cookie. The token itself never goes into a URL. The cookie is derived from the token,
// so unpairing (a new token) signs every phone out, and turning sync off closes the listener.
// Signed-in requests are passed to the main server, which only answers local hosts.

const WEB_OPEN_PATH = "/phone/open";
const SESSION_COOKIE = "pm_phone";
const CODE_TTL_MS = 60_000;
const noStore = { "cache-control": "no-store" };

const webCodes = new Map<string, number>();
let webTarget: string | null = null;

/** Where the main server listens, for passing a signed-in phone's requests on. */
export function setWebTarget(url: string) {
  webTarget = url.replace(/\/+$/, "");
}

function issueWebCode(now = Date.now()): string {
  for (const [code, expires] of webCodes) if (expires < now) webCodes.delete(code);
  const code = randomBytes(24).toString("base64url");
  webCodes.set(code, now + CODE_TTL_MS);
  return code;
}

/** The cookie a signed-in phone carries: a hash of the pairing token, never the token itself. */
export function sessionValue(token = pairingToken()): string {
  return createHmac("sha256", token).update("photomap phone web session").digest("base64url");
}

function cookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export function phoneSession(req: Request): boolean {
  const given = Buffer.from(cookie(req, SESSION_COOKIE) ?? "");
  const want = Buffer.from(sessionValue());
  return given.length === want.length && timingSafeEqual(given, want);
}

const browser = (req: Request) => req.headers.get("user-agent") ?? "unknown browser";

function openWeb(req: Request): Response {
  const code = new URL(req.url).searchParams.get("code") ?? "";
  const expires = webCodes.get(code);
  webCodes.delete(code);
  if (req.method !== "GET" || !expires || expires < Date.now()) {
    const why = req.method !== "GET" ? req.method : expires ? "expired" : "unknown or used code";
    console.log(`Phone web: sign-in link refused, ${why} (${browser(req)})`);
    return page(
      "This link has expired",
      "Open Photomap again from the app on your phone. Each link works once, for a minute.",
      401,
    );
  }
  console.log(`Phone signed in to the web app (${browser(req)})`);
  // A page that moves on to the app, rather than a redirect: the cookie is stored by the time "/" is
  // requested, and replace() drops the spent link from the browser's history.
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<meta http-equiv="refresh" content="0;url=/"><title>Opening Photomap</title>` +
      `<body style="font:16px/1.5 system-ui,sans-serif;margin:15vh auto;padding:0 24px;color:#6b675f;background:#f6f5f2">` +
      `Opening Photomap…<script>location.replace("/")</script>`,
    {
      headers: {
        ...noStore,
        ...closeConnection,
        "content-type": "text/html; charset=utf-8",
        // A year: the phone stays signed in until it's unpaired. No Secure flag: the LAN listener is plain HTTP.
        // Lax, not Strict: a link opened from another app can count as cross-site, and Strict would drop the cookie
        // there. Writes stay protected by the Origin check in proxyWeb.
        "set-cookie": `${SESSION_COOKIE}=${sessionValue()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
      },
    },
  );
}

const notSignedIn = () =>
  page(
    "Open Photomap from your phone",
    "This address is for phones paired with Photomap. Open it from the Photomap app on your phone.",
    401,
  );

function page(title: string, text: string, status: number): Response {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${esc(title)}</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:32em;margin:15vh auto;padding:0 24px;color:#1d1b17;background:#f6f5f2">` +
      `<h1 style="font-size:22px;font-weight:600">${esc(title)}</h1><p style="color:#6b675f">${esc(text)}</p>`,
    { status, headers: { ...noStore, ...closeConnection, "content-type": "text/html; charset=utf-8" } },
  );
}

/**
 * Browsers get a fresh connection for every request on this listener. Chrome reports a request whose
 * reused connection fails twice as ERR_TOO_MANY_RETRIES, which a phone hit here; with no reuse there's
 * nothing to fail that way. The cost is a TCP handshake per request, on the local network.
 */
const closeConnection = { connection: "close" };

/** Hop-by-hop headers belong to one connection and are never passed on (RFC 9110 §7.6.1). */
const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
];

async function proxyWeb(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (!webTarget) return page("Photomap is still starting", "Try again in a moment.", 503);
  // Live reload in development: a WebSocket, which isn't passed on. Refuse it cleanly.
  if (req.headers.get("upgrade")) return new Response(null, { status: 404, headers: closeConnection });
  const host = req.headers.get("host") ?? url.host;
  // Other sites' writes: the cookie is SameSite=Lax, so only this check stops a cross-site POST.
  const origin = req.headers.get("origin");
  if (req.method !== "GET" && req.method !== "HEAD" && origin !== null && origin !== `http://${host}`) {
    return bad("Forbidden", 403);
  }
  const headers = new Headers(req.headers);
  // The main server answers only local hosts, and only its own origin; this request is ours now.
  for (const h of ["host", "origin", "referer", "cookie", "content-length", ...HOP_BY_HOP]) headers.delete(h);
  try {
    const res = await fetch(webTarget + url.pathname + url.search, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
      redirect: "manual",
      decompress: false,
    });
    const out = new Headers(res.headers);
    for (const h of HOP_BY_HOP) out.delete(h);
    out.set("connection", "close");
    if (res.status >= 500) console.error(`Phone web: ${req.method} ${url.pathname} answered ${res.status}`);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
  } catch (e) {
    console.error(`Phone web: ${req.method} ${url.pathname} failed:`, e);
    return page("Photomap didn't answer", `${(e as Error).message}. Try again in a moment.`, 502);
  }
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
      // Anything that slips past the handlers above: answer and log it, rather than drop the connection.
      error(e) {
        console.error("Phone sync request failed:", e);
        return new Response("Photomap couldn't handle this request.", { status: 500, headers: closeConnection });
      },
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
  const folder = syncDir();
  let indexedFolder: string | null = null;
  try {
    indexedFolder = normalizeFolder(folder);
  } catch {
    // The default destination may not exist until sync starts.
  }
  return {
    enabled,
    listening: listener !== null,
    error: listenError,
    url,
    port: SYNC_PORT,
    folder,
    indexedFolder,
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
