import { afterEach, describe, expect, test } from "bun:test";
import { probe } from "./connection";
import type { Pairing } from "./pairing";

const pairing: Pairing = { url: "http://192.168.1.33:4748", token: "t0k3n", name: "irondsd" };
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Replaces fetch with one that answers every request with `respond`. */
function serve(respond: (req: Request, signal?: AbortSignal | null) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    respond(new Request(input, init), init?.signal)) as typeof fetch;
}

describe("probe", () => {
  test("online when the Mac answers, with the name it gives", async () => {
    let auth = null as string | null;
    serve((req) => {
      auth = req.headers.get("authorization");
      return Response.json({ name: "Kostya's MacBook", protocol: 1 });
    });
    expect(await probe(pairing)).toEqual({ state: "online", name: "Kostya's MacBook" });
    expect(auth).toBe("Bearer t0k3n");
  });

  test("offline when nothing answers", async () => {
    serve(() => {
      throw new TypeError("Network request failed");
    });
    expect(await probe(pairing)).toEqual({
      state: "offline",
      reason: "Can't reach irondsd at 192.168.1.33:4748.",
    });
  });

  test("offline when the Mac doesn't answer in time, e.g. asleep", async () => {
    serve(
      (_, signal) =>
        new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new DOMException("", "AbortError")))),
    );
    const started = Date.now();
    expect(await probe(pairing, 50)).toMatchObject({
      state: "offline",
      reason: expect.stringContaining("Can't reach"),
    });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("unpaired when the token was reset", async () => {
    serve(() => Response.json({ error: "This phone isn't paired with Photomap" }, { status: 401 }));
    expect(await probe(pairing)).toEqual({ state: "unpaired" });
  });

  test("offline with the server's message when something else answers on that port", async () => {
    serve(() => Response.json({ error: "not found" }, { status: 404 }));
    expect(await probe(pairing)).toEqual({ state: "offline", reason: "not found" });
  });

  test("offline when the Mac runs a different sync version", async () => {
    serve(() => Response.json({ name: "irondsd", protocol: 2 }));
    expect(await probe(pairing)).toMatchObject({ state: "offline", reason: expect.stringContaining("versions") });
  });
});
