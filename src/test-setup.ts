import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Before anything imports config.ts: tests get a throwaway index and thumbnail folder.
const dir = mkdtempSync(join(tmpdir(), "photomap-test-"));
process.env.PHOTOMAP_DATA = dir;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
