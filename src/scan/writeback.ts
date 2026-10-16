/**
 * Writes dates and locations set by hand back into the photo files, with exiftool.
 * The only code that ever changes a photo file; see writeback-cli.ts.
 */
import { stat, utimes } from "node:fs/promises";
import type { PhotoRow } from "../db";
import type { Extracted } from "./extract";
import { isManualDate } from "./manualDates";

export type WritebackRow = Pick<
  PhotoRow,
  "id" | "path" | "name" | "kind" | "taken_local" | "tz_offset" | "time_source" | "lat" | "lon" | "gps_source"
>;

/** What the file needs to agree with the index. */
export interface Change {
  date?: { local: number; offset: number | null };
  location?: { lat: number; lon: number };
}

// Videos store ISO 6709 strings with 4 decimals (about 10 m); EXIF rationals are far finer.
const SAME_PLACE_DEG = 1e-4;

/**
 * Compares a photo's index entry with what its file says (a fresh extract). Only hand-set
 * values are written: the file's own ones are already in it, and inferred ones are guesses.
 * Null when the file already agrees.
 */
export function pendingChange(row: WritebackRow, file: Extracted): Change | null {
  const change: Change = {};
  if (row.gps_source === "manual" && row.lat != null && row.lon != null) {
    const same =
      file.lat != null &&
      file.lon != null &&
      Math.abs(file.lat - row.lat) < SAME_PLACE_DEG &&
      Math.abs(file.lon - row.lon) < SAME_PLACE_DEG;
    if (!same) change.location = { lat: row.lat, lon: row.lon };
  }
  if (isManualDate(row.time_source) && row.taken_local != null) {
    const local = Math.floor(row.taken_local);
    // A date that only comes from the file name or mtime isn't in the file's metadata.
    const tagged =
      row.kind === "video" ? !!file.time_source?.startsWith("video") : !!file.time_source?.startsWith("exif");
    const same =
      tagged &&
      file.taken_local != null &&
      Math.floor(file.taken_local) === local &&
      (row.tz_offset == null || file.tz_offset === row.tz_offset);
    if (!same) change.date = { local, offset: row.tz_offset };
  }
  return change.date || change.location ? change : null;
}

const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, "0");

/** Wall seconds → "2019:07:14 15:00:00", exiftool's date format. */
export function exifDate(wall: number): string {
  const d = new Date(wall * 1000);
  return (
    `${pad(d.getUTCFullYear(), 4)}:${pad(d.getUTCMonth() + 1)}:${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

/** Minutes east of UTC → "+02:00". */
export function exifOffset(min: number): string {
  return `${min < 0 ? "-" : "+"}${pad(Math.trunc(min / 60))}:${pad(min % 60)}`;
}

/**
 * exiftool arguments (before the file path) that write a change. The file's modified time
 * is kept (-P): it's the last-resort date of photos with none in their metadata. Without
 * `overwrite`, exiftool keeps the untouched file next to it as "<name>_original".
 */
export function exiftoolArgs(kind: WritebackRow["kind"], change: Change, overwrite: boolean): string[] {
  const args = ["-P"];
  if (overwrite) args.push("-overwrite_original");
  const loc = change.location;
  const date = change.date;
  if (kind === "video") {
    if (loc) {
      // Apple's location key, and the older ©xyz atom other apps read.
      const coords = `${loc.lat}, ${loc.lon}`;
      args.push(`-Keys:GPSCoordinates=${coords}`, `-UserData:GPSCoordinates=${coords}`);
    }
    if (date) {
      const off = date.offset != null ? exifOffset(date.offset) : "";
      args.push(`-Keys:CreationDate=${exifDate(date.local)}${off}`);
      // The movie header dates are UTC: only writable when the offset is known.
      if (date.offset != null) {
        const utc = exifDate(date.local - date.offset * 60);
        args.push(
          `-QuickTime:CreateDate=${utc}`,
          `-QuickTime:TrackCreateDate=${utc}`,
          `-QuickTime:MediaCreateDate=${utc}`,
        );
      }
    }
    return args;
  }
  if (loc) {
    args.push(
      `-EXIF:GPSLatitude=${Math.abs(loc.lat)}`,
      `-EXIF:GPSLatitudeRef=${loc.lat < 0 ? "S" : "N"}`,
      `-EXIF:GPSLongitude=${Math.abs(loc.lon)}`,
      `-EXIF:GPSLongitudeRef=${loc.lon < 0 ? "W" : "E"}`,
      // The index has no altitude for hand-set places; the file's belongs to the old one.
      "-EXIF:GPSAltitude=",
      "-EXIF:GPSAltitudeRef=",
    );
  }
  if (date) {
    const d = exifDate(date.local);
    args.push(`-EXIF:DateTimeOriginal=${d}`, `-EXIF:CreateDate=${d}`);
    if (date.offset != null) {
      const off = exifOffset(date.offset);
      args.push(`-EXIF:OffsetTimeOriginal=${off}`, `-EXIF:OffsetTimeDigitized=${off}`);
    }
  }
  return args;
}

/** Runs exiftool on one file; returns its error message, or null on success. */
export async function writeFile(path: string, args: string[]): Promise<string | null> {
  const before = await stat(path);
  const r = await Bun.$`exiftool ${args} ${path}`.quiet().nothrow();
  if (r.exitCode === 0) {
    // -P keeps whole seconds only; put back the exact time.
    await utimes(path, before.atime, before.mtime);
    return null;
  }
  const msg = r.stderr.toString().trim() || r.stdout.toString().trim();
  return msg.replace(/\s*-\s*\/.*$/gm, "").split("\n")[0] || `exiftool exited with ${r.exitCode}`;
}
