import { join } from "node:path";
import { db } from "../db";
import { pendingFacePhotos } from "./store";

/** Watch the trial index so scans from either the server or the CLI are picked up. */
export function watchForNewPhotos(isScanning: () => boolean) {
  const pending = db.query(`SELECT 1 ${pendingFacePhotos} AND s.photo_id IS NULL LIMIT 1`);
  let running = false;
  let retryAfter = 0;
  const check = async () => {
    if (running || isScanning() || Date.now() < retryAfter) return;
    running = true;
    try {
      if (!pending.get()) return;
      const detector = Bun.spawn([process.execPath, join(import.meta.dir, "cli.ts")], {
        stdout: "inherit",
        stderr: "inherit",
      });
      if (await detector.exited) throw new Error("Face detection exited early. See the detector log above.");
    } catch (error) {
      console.error("Automatic face detection:", error);
      retryAfter = Date.now() + 60_000;
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void check(), 5000);
  timer.unref();
  void check();
}
