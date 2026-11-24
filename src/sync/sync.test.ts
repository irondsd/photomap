import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SYNC_DIR as SYNC_DIR } from "../config";
import { addRoot, db } from "../db";
import { setSyncLayout } from "./folder";
import { UPLOAD_HEADERS, type ManifestItem } from "./protocol";
import { destination, safeFilename } from "./receive";
import {
  authorized,
  handleSync,
  lanAddresses,
  pairingToken,
  phoneSession,
  resetToken,
  sessionValue,
  setWebTarget,
} from "./service";

// Nothing listens here: a signed-in request that got past the checks would fail to connect, not pass.
setWebTarget("http://127.0.0.1:9");

function req(path: string, init: RequestInit & { token?: string | null } = {}) {
  const { token = pairingToken(), ...rest } = init;
  const headers = new Headers(rest.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  return new Request(`http://192.168.1.20:4748${path}`, { ...rest, headers });
}

const send = (r: Request, onReceived = () => {}) => Promise.resolve(handleSync(r, onReceived));

const upload = (filename: string, takenAt: number, bytes: string, kind = "photo") =>
  req("/api/sync/file", {
    method: "PUT",
    body: bytes,
    headers: {
      [UPLOAD_HEADERS.filename]: encodeURIComponent(filename),
      [UPLOAD_HEADERS.takenAt]: String(takenAt),
      [UPLOAD_HEADERS.kind]: kind,
    },
  });

const check = (items: ManifestItem[]) =>
  send(req("/api/sync/check", { method: "POST", body: JSON.stringify({ items }) })).then(
    async (r) => (await r.json()) as { missing: string[] },
  );

// 2026-03-14 12:00 local time, so the month folder doesn't depend on the test machine's zone.
const MARCH = new Date(2026, 2, 14, 12).getTime();

describe("auth", () => {
  test("needs the pairing token", async () => {
    expect((await send(req("/api/sync/hello", { token: null }))).status).toBe(401);
    expect((await send(req("/api/sync/hello", { token: "nope" }))).status).toBe(401);
    const ok = await send(req("/api/sync/hello"));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ protocol: 1 });
  });

  test("resetting the token unpairs phones", async () => {
    const before = pairingToken();
    resetToken();
    expect(pairingToken()).not.toBe(before);
    expect(authorized(req("/api/sync/hello", { token: before }))).toBe(false);
  });

  test("serves nothing but the sync API to a phone that isn't signed in to the web app", async () => {
    expect((await send(req("/api/points"))).status).toBe(401);
    expect((await send(req("/original/1"))).status).toBe(401);
    expect((await send(req("/", { token: null }))).status).toBe(401);
  });
});

describe("web app for paired phones", () => {
  const webCode = async (token?: string | null) => {
    const r = await send(req("/api/sync/web-code", { method: "POST", token }));
    return { status: r.status, path: r.ok ? ((await r.json()) as { path: string }).path : "" };
  };
  const open = (path: string) => send(req(path, { token: null }));
  const sessionCookie = (r: Response) => (r.headers.get("set-cookie") ?? "").split(";")[0]!;

  test("needs the pairing token to get a code", async () => {
    expect((await webCode(null)).status).toBe(401);
    expect((await webCode("nope")).status).toBe(401);
  });

  test("a code signs the browser in once, without putting the token anywhere", async () => {
    const { path } = await webCode();
    expect(path).not.toContain(pairingToken());
    const first = await open(path);
    expect(first.status).toBe(200);
    expect(await first.text()).toContain('location.replace("/")');
    const set = first.headers.get("set-cookie")!;
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Lax");
    expect(set).not.toContain(pairingToken());
    expect(sessionCookie(first)).toBe(`pm_phone=${sessionValue()}`);
    expect((await open(path)).status).toBe(401);
    expect((await open("/phone/open?code=made-up")).status).toBe(401);
  });

  test("the session cookie is what opens the web app, and unpairing ends it", async () => {
    const signedIn = (cookie: string) => phoneSession(req("/", { token: null, headers: { cookie } }));
    const value = `pm_phone=${sessionValue()}`;
    expect(signedIn(`other=1; ${value}`)).toBe(true);
    expect(signedIn("pm_phone=nope")).toBe(false);
    resetToken();
    expect(signedIn(value)).toBe(false);
  });

  test("a request the main server can't answer gets a page, not a dropped connection", async () => {
    const r = await send(req("/", { token: null, headers: { cookie: `pm_phone=${sessionValue()}` } }));
    expect(r.status).toBe(502);
    expect(r.headers.get("connection")).toBe("close");
  });

  test("refuses writes from another site", async () => {
    const cookie = `pm_phone=${sessionValue()}`;
    const r = await send(
      req("/api/albums", { method: "POST", token: null, headers: { cookie, origin: "http://evil.example" } }),
    );
    expect(r.status).toBe(403);
  });
});

describe("check and upload", () => {
  test("stores a file under year/month and stops asking for it", async () => {
    const item: ManifestItem = { id: "a", filename: "IMG_0001.jpg", takenAt: MARCH, kind: "photo" };
    expect(await check([item])).toEqual({ missing: ["a"] });

    let scans = 0;
    const res = await send(upload("IMG_0001.jpg", MARCH, "jpeg bytes"), () => scans++);
    expect(res.status).toBe(200);
    const { path } = (await res.json()) as { path: string };
    expect(path).toBe(join("2026", "03", "IMG_0001.jpg"));
    const file = join(SYNC_DIR, path);
    expect(readFileSync(file, "utf8")).toBe("jpeg bytes");
    expect(Math.round(statSync(file).mtimeMs)).toBe(MARCH);

    expect(await check([item])).toEqual({ missing: [] });
  });

  test("an upload sent twice is stored once", async () => {
    await send(upload("IMG_0002.jpg", MARCH, "one"));
    const again = await send(upload("IMG_0002.jpg", MARCH, "one"));
    expect(((await again.json()) as { path: string }).path).toBe(join("2026", "03", "IMG_0002.jpg"));
    expect(existsSync(join(SYNC_DIR, "2026", "03", "IMG_0002 (2).jpg"))).toBe(false);
  });

  test("a different file with a taken name gets a suffix", async () => {
    await send(upload("IMG_0003.jpg", MARCH, "first"));
    const res = await send(upload("IMG_0003.jpg", MARCH + 1000, "second"));
    expect(((await res.json()) as { path: string }).path).toBe(join("2026", "03", "IMG_0003 (2).jpg"));
  });

  test("a truncated upload leaves nothing behind", async () => {
    const r = upload("IMG_0004.jpg", MARCH, "short");
    const truncated = new Request(r, { headers: { ...Object.fromEntries(r.headers), "content-length": "999" } });
    const res = await send(truncated);
    expect(res.status).toBe(400);
    expect(existsSync(join(SYNC_DIR, "2026", "03", "IMG_0004.jpg"))).toBe(false);
    expect(await check([{ id: "x", filename: "IMG_0004.jpg", takenAt: MARCH, kind: "photo" }])).toEqual({
      missing: ["x"],
    });
  });

  test("rejects names that would escape the sync folder", async () => {
    for (const name of ["../evil.jpg", "a/b.jpg", "..", ".hidden.jpg", ""]) {
      expect((await send(upload(name, MARCH, "x"))).status).toBe(400);
    }
  });

  test("rejects malformed checks", async () => {
    const bad = (body: unknown) => send(req("/api/sync/check", { method: "POST", body: JSON.stringify(body) }));
    expect((await bad({})).status).toBe(400);
    expect((await bad({ items: [{ id: "a", filename: "x.jpg" }] })).status).toBe(400);
    expect((await bad({ items: Array.from({ length: 501 }, () => ({})) })).status).toBe(400);
  });
});

describe("files already in the library", () => {
  // A camera roll copied over some other way: indexed photos with the local wall-clock time.
  const root = addRoot("/library-test");
  const indexed = (name: string, takenLocal: number | null) =>
    db.run(
      `INSERT INTO photos (root_id, path, rel_dir, name, ext, kind, size, mtime, scan_gen, taken_local, indexed_at)
       VALUES (?, ?, 'CameraRoll', ?, 'jpg', 'photo', 1, 0, 0, ?, 0)`,
      [root.id, `/library-test/CameraRoll/${name}`, name, takenLocal],
    );
  // 2026-10-30 17:59:48 UTC, taken in Buenos Aires (UTC-3): indexed as 14:59:48 local.
  const utc = Date.UTC(2026, 9, 30, 17, 59, 48, 701);
  const local = Date.UTC(2026, 9, 30, 14, 59, 48) / 1000;
  indexed("PXL_20261030_175948701.MP.jpg", local);
  indexed("IMG_0001.jpg", local);
  indexed("undated.jpg", null);

  test("aren't asked for again", async () => {
    expect(await check([{ id: "p", filename: "PXL_20261030_175948701.MP.jpg", takenAt: utc, kind: "photo" }])).toEqual({
      missing: [],
    });
  });

  test("a generic name from another day is a different photo", async () => {
    const weekLater = utc + 7 * 24 * 3600 * 1000;
    expect(await check([{ id: "i", filename: "IMG_0001.jpg", takenAt: weekLater, kind: "photo" }])).toEqual({
      missing: ["i"],
    });
  });

  test("an undated library photo with the same name counts as the same file", async () => {
    expect(await check([{ id: "u", filename: "undated.jpg", takenAt: utc, kind: "photo" }])).toEqual({ missing: [] });
  });

  test("files gone from disk don't count", async () => {
    db.run(`UPDATE photos SET missing = 1 WHERE name = 'IMG_0001.jpg'`);
    expect(await check([{ id: "i", filename: "IMG_0001.jpg", takenAt: utc, kind: "photo" }])).toEqual({
      missing: ["i"],
    });
  });
});

describe("flat layout", () => {
  test("puts files straight in the sync folder", async () => {
    setSyncLayout("flat");
    try {
      const res = await send(upload("PXL_20260314_120000000.jpg", MARCH, "flat"));
      expect(((await res.json()) as { path: string }).path).toBe("PXL_20260314_120000000.jpg");
      expect(readFileSync(join(SYNC_DIR, "PXL_20260314_120000000.jpg"), "utf8")).toBe("flat");
    } finally {
      setSyncLayout("month");
    }
  });
});

describe("helpers", () => {
  test("safeFilename", () => {
    expect(safeFilename("PXL_20260314_120000.mp4")).toBe("PXL_20260314_120000.mp4");
    expect(safeFilename("with space (1).jpg")).toBe("with space (1).jpg");
    expect(safeFilename("x\\y.jpg")).toBeNull();
    expect(safeFilename("a".repeat(256))).toBeNull();
  });

  test("destination keeps the extension when adding a suffix", () => {
    expect(destination(SYNC_DIR, "IMG_0003.jpg", MARCH)).toBe(join(SYNC_DIR, "2026", "03", "IMG_0003 (3).jpg"));
  });

  test("lanAddresses prefers wifi over VPNs and VM bridges, and skips public and loopback", () => {
    const iface = (address: string, internal = false) => ({
      address,
      family: "IPv4" as const,
      internal,
      netmask: "255.255.255.0",
      mac: "00:00:00:00:00:00",
      cidr: null,
    });
    expect(
      lanAddresses({
        lo0: [iface("127.0.0.1", true)],
        bridge100: [iface("192.168.64.1")],
        utun4: [iface("10.8.0.2")],
        en0: [iface("192.168.1.20")],
        en5: [iface("8.8.8.8")],
      }),
    ).toEqual(["192.168.1.20", "192.168.64.1", "10.8.0.2"]);
  });
});

test("the app's copy of the protocol matches the server's", () => {
  const body = (path: string) =>
    readFileSync(join(import.meta.dir, path), "utf8")
      .split("\n")
      .filter((line, i, lines) => !lines.slice(0, i + 1).every((l) => l.startsWith("//") || l === ""))
      .join("\n");
  expect(body("../../mobile/src/protocol.ts")).toBe(body("protocol.ts"));
});
