import { join } from "node:path";
import { requireCopiedIndex } from "./trial";
import { FaceGroups, EMBEDDING_SIZE } from "./group";
import type { FaceBox } from "./images";

const args = Bun.argv.slice(2);
if (args.some((arg) => arg !== "--retry-failed")) {
  throw new Error("Usage: bun run people:detect [--retry-failed]");
}
if (process.env.PHOTOMAP_PEOPLE_AUTO !== "1" || process.env.PHOTOMAP_PEOPLE_PREVIEW === "1") {
  requireCopiedIndex();
}

const { db } = await import("../db");
const { CPUS, DATA_DIR } = await import("../config");
const { faceImage } = await import("./images");
const { pendingFacePhotos, facePhotos, initPeople, regroupPeople } = await import("./store");
type Photo = Parameters<typeof faceImage>[0] & { size: number };
type Face = FaceBox & { quality: number; embedding: number[] };

const models = process.env.PHOTOMAP_FACE_MODELS ?? join(DATA_DIR, "models");
const python = process.env.PHOTOMAP_FACE_PYTHON ?? "python3";
const workers = Number(process.env.PHOTOMAP_FACE_WORKERS ?? Math.min(6, Math.max(1, CPUS - 2)));
if (!Number.isSafeInteger(workers) || workers < 1 || workers > 32) {
  throw new Error("PHOTOMAP_FACE_WORKERS must be between 1 and 32.");
}

const modelFiles = [
  [join(models, "yunet.onnx"), "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"],
  [join(models, "sface.onnx"), "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79"],
] as const;
for (const [file, checksum] of modelFiles) {
  const model = Bun.file(file);
  if (
    !(await model.exists()) ||
    new Bun.CryptoHasher("sha256").update(await model.arrayBuffer()).digest("hex") !== checksum
  ) {
    throw new Error(`Missing or unexpected model file: ${file}. See the People setup in README.md.`);
  }
}

initPeople();
db.run("PRAGMA busy_timeout = 5000");

const pending = db
  .query<Photo, []>(
    `SELECT p.id, p.path, p.kind, p.duration, p.mtime, p.size
  ${pendingFacePhotos} AND (s.photo_id IS NULL${args.includes("--retry-failed") ? " OR s.failed = 1" : ""})
  ORDER BY p.id`,
  )
  .all();

const reload = () => {
  const groups = new FaceGroups();
  for (const face of db
    .query<{ person_id: number; embedding: Uint8Array }, []>(`SELECT f.person_id, f.embedding ${facePhotos}`)
    .iterate()) {
    groups.add(face.person_id, new Float32Array(face.embedding.slice().buffer));
  }
  return groups;
};

const version = db.query<{ data_version: number }, []>("PRAGMA data_version");
let indexVersion = -1;
let groups: FaceGroups;
const currentPhoto = db.query(
  "SELECT 1 FROM photos WHERE id = ? AND path = ? AND mtime = ? AND size = ? AND missing = 0",
);
const scanned = db.query<{ failed: number }, [number, number, number]>(
  "SELECT failed FROM face_scans WHERE photo_id = ? AND mtime = ? AND size = ?",
);
const scan = db.query("INSERT INTO face_scans (photo_id, mtime, size, failed) VALUES (?, ?, ?, ?)");
const removePrevious = db.query("DELETE FROM face_scans WHERE photo_id = ?");
const savePerson = db.query<{ id: number }, []>("INSERT INTO people DEFAULT VALUES RETURNING id");
const saveFace = db.query(`INSERT INTO faces (photo_id, person_id, x, y, w, h, quality, embedding)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
const saveBatch = db.transaction((batch: { photo: Photo; faces: Face[] | null }[]) => {
  const nextVersion = version.get()!.data_version;
  if (nextVersion !== indexVersion) {
    groups = reload();
    indexVersion = nextVersion;
  }
  for (const { photo, faces } of batch) {
    if (!currentPhoto.get(photo.id, photo.path, photo.mtime, photo.size)) continue;
    const previous = scanned.get(photo.id, photo.mtime, photo.size);
    if (previous && (!previous.failed || !args.includes("--retry-failed"))) continue;
    removePrevious.run(photo.id);
    scan.run(photo.id, photo.mtime, photo.size, faces == null ? 1 : 0);
    const inPhoto = new Set<number>();
    for (const face of faces?.sort((a, b) => b.quality - a.quality) ?? []) {
      const vector = Float32Array.from(face.embedding);
      const id = groups.match(vector, inPhoto) ?? savePerson.get()!.id;
      inPhoto.add(id);
      groups.add(id, vector);
      saveFace.run(photo.id, id, face.x, face.y, face.w, face.h, face.quality, new Uint8Array(vector.buffer));
    }
  }
});

async function* lines(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let remaining = "";
  for await (const chunk of stream) {
    remaining += decoder.decode(chunk, { stream: true });
    const parts = remaining.split("\n");
    remaining = parts.pop()!;
    yield* parts;
  }
}

let cursor = 0;
let done = 0;
let failed = 0;
let facesFound = 0;
let stopped = false;
const batch: { photo: Photo; faces: Face[] | null }[] = [];

async function runWorker() {
  const input = new TransformStream<Uint8Array>();
  const writer = input.writable.getWriter();
  const process = Bun.spawn([python, join(import.meta.dir, "infer.py"), ...modelFiles.map(([file]) => file)], {
    stdin: input.readable,
    stdout: "pipe",
    stderr: "inherit",
  });
  const output = lines(process.stdout);
  const encoder = new TextEncoder();
  try {
    if ((await output.next()).value !== "ready")
      throw new Error("OpenCV failed to load. See the People setup in README.md.");
    while (!stopped && cursor < pending.length) {
      const photo = pending[cursor++]!;
      const image = await faceImage(photo);
      let faces: Face[] | null = null;
      if (image) {
        await writer.write(encoder.encode(image.toString("base64") + "\n"));
        const result = await output.next();
        if (result.done) throw new Error("The face inference process exited early.");
        faces = JSON.parse(result.value) as Face[] | null;
        if (faces?.some((face) => face.embedding.length !== EMBEDDING_SIZE))
          throw new Error("Unexpected embedding size.");
      }
      if (!faces) failed++;
      else facesFound += faces.length;
      batch.push({ photo, faces });
      done++;
      if (done === 100 && failed === 100)
        throw new Error("The first 100 images could not be processed. Check library access and OpenCV.");
      if (batch.length >= 64) saveBatch.immediate(batch.splice(0));
      if (done % 500 === 0)
        console.log(`Processed ${done}/${pending.length} photos · ${facesFound} faces · ${failed} errors`);
    }
  } catch (error) {
    stopped = true;
    throw error;
  } finally {
    process.kill();
    await process.exited;
    await writer.abort().catch(() => {});
  }
}

console.log(`Processing ${pending.length} photos with up to ${workers} local workers.`);
const signals = () => {
  stopped = true;
};
process.on("SIGINT", signals);
process.on("SIGTERM", signals);
const results = await Promise.allSettled(Array.from({ length: Math.min(workers, pending.length) }, runWorker));
if (batch.length) saveBatch.immediate(batch);
const error = results.find((result) => result.status === "rejected");
if (error) throw error.reason;
console.log(
  `${stopped ? "Paused" : "Finished"}: ${done}/${pending.length} photos processed, ${facesFound} faces, ${failed} errors.`,
);
if (stopped) process.exitCode = 130;
else if (facesFound) {
  // New faces can bridge two groups of one person. Fold such duplicates together.
  const { groupsBefore, groupsAfter } = regroupPeople.immediate(false);
  if (groupsAfter < groupsBefore) console.log(`Merged duplicate groups: ${groupsBefore} → ${groupsAfter}.`);
}
