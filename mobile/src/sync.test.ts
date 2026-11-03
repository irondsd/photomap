import { describe, expect, test } from "bun:test";
import { ServerError, errorMessage } from "./api";
import { CHECK_BATCH, type ManifestItem } from "./protocol";
import { MAX_CONSECUTIVE_FAILURES, runSync, type SyncDeps, type SyncProgress } from "./sync";

const item = (n: number): ManifestItem => ({
  id: String(n),
  filename: `IMG_${n}.jpg`,
  takenAt: 1_700_000_000_000 + n,
  kind: "photo",
});
const library = (count: number) => Array.from({ length: count }, (_, i) => item(i));

/** A fake phone + server: `have` is what the server already holds, `fail` decides per upload. */
function fake(
  items: ManifestItem[],
  have: string[] = [],
  fail?: (item: ManifestItem, attempt: number) => Error | null,
) {
  const stored = new Set(have);
  const attempts = new Map<string, number>();
  const pages: number[] = [];
  const deps: SyncDeps = {
    async listPage(offset, limit) {
      pages.push(offset);
      const page = items.slice(offset, offset + limit);
      return { items: page, count: page.length };
    },
    async check(batch) {
      return batch.filter((i) => !stored.has(i.id)).map((i) => i.id);
    },
    async upload(i, onBytes) {
      const attempt = (attempts.get(i.id) ?? 0) + 1;
      attempts.set(i.id, attempt);
      const error = fail?.(i, attempt);
      if (error) throw error;
      onBytes(10, 10);
      stored.add(i.id);
    },
  };
  return { deps, stored, attempts, pages };
}

const run = (deps: SyncDeps, signal = new AbortController().signal) => {
  const progress: SyncProgress[] = [];
  return runSync(deps, { onProgress: (p) => progress.push(p), signal }).then((result) => ({ result, progress }));
};

describe("runSync", () => {
  test("uploads only what the server lacks", async () => {
    const { deps, stored } = fake(library(5), ["0", "2"]);
    const { result } = await run(deps);
    expect(result).toEqual({ scanned: 5, present: 2, uploaded: 3, failed: [], cancelled: false });
    expect([...stored].sort()).toEqual(["0", "1", "2", "3", "4"]);
  });

  test("pages through libraries larger than one check", async () => {
    const { deps, pages } = fake(library(CHECK_BATCH * 2 + 3));
    const { result } = await run(deps);
    expect(pages).toEqual([0, CHECK_BATCH, CHECK_BATCH * 2]);
    expect(result.uploaded).toBe(CHECK_BATCH * 2 + 3);
  });

  test("asks for one more page when the last one was exactly full", async () => {
    const { deps, pages } = fake(library(CHECK_BATCH));
    await run(deps);
    expect(pages).toEqual([0, CHECK_BATCH]);
  });

  test("checks everything before uploading, so the total is known", async () => {
    const { deps } = fake(library(3));
    const { progress } = await run(deps);
    const firstUpload = progress.findIndex((p) => p.phase === "uploading");
    expect(progress.slice(firstUpload).every((p) => p.phase === "uploading")).toBe(true);
    expect(progress[firstUpload]).toMatchObject({ phase: "uploading", total: 3, done: 0 });
    expect(progress.at(-1)).toMatchObject({ phase: "uploading", total: 3, done: 3 });
  });

  test("retries a dropped connection once", async () => {
    const { deps, attempts } = fake(library(1), [], (_, attempt) => (attempt === 1 ? new TypeError("Network") : null));
    const { result } = await run(deps);
    expect(result.uploaded).toBe(1);
    expect(attempts.get("0")).toBe(2);
  });

  test("doesn't retry a file the server rejected, and carries on with the rest", async () => {
    const { deps, attempts } = fake(library(3), [], (i) => (i.id === "1" ? new ServerError(500, "Disk full") : null));
    const { result } = await run(deps);
    expect(attempts.get("1")).toBe(1);
    expect(result.uploaded).toBe(2);
    expect(result.failed).toEqual([{ filename: "IMG_1.jpg", error: "Disk full" }]);
    expect(result.stopped).toBeUndefined();
  });

  test("gives up after repeated lost connections", async () => {
    const { deps } = fake(library(10), [], () => new TypeError("Network request failed"));
    const { result } = await run(deps);
    expect(result.failed).toHaveLength(MAX_CONSECUTIVE_FAILURES);
    expect(result.stopped).toContain("Lost the connection");
  });

  test("stops at once when the pairing is revoked", async () => {
    const { deps } = fake(library(3), [], () => new ServerError(401, errorMessage(401, "")));
    const { result } = await run(deps);
    expect(result.failed).toEqual([]);
    expect(result.stopped).toContain("Scan the code");
  });

  test("reports a failed check without uploading anything", async () => {
    const { deps } = fake(library(3));
    deps.check = async () => {
      throw new TypeError("Network request failed");
    };
    const { result } = await run(deps);
    expect(result).toMatchObject({ uploaded: 0, stopped: "Network request failed" });
  });

  test("stops between files when cancelled", async () => {
    const controller = new AbortController();
    const { deps, stored } = fake(library(5));
    const upload = deps.upload;
    deps.upload = async (i, onBytes, signal) => {
      await upload(i, onBytes, signal);
      if (i.id === "1") controller.abort();
    };
    const { result } = await run(deps, controller.signal);
    expect(result).toMatchObject({ cancelled: true, uploaded: 2 });
    expect(stored.size).toBe(2);
  });
});

describe("errorMessage", () => {
  test("uses the server's error when it sent one", () => {
    expect(errorMessage(400, JSON.stringify({ error: "Missing filename" }))).toBe("Missing filename");
  });

  test("falls back to the status", () => {
    expect(errorMessage(502, "<html>Bad gateway</html>")).toBe("Photomap answered 502.");
  });
});
