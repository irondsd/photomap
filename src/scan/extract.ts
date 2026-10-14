import exifr from "exifr";
import { iso1A2Code, feature } from "@rapideditor/country-coder";
import type { Kind } from "../config";
import { parseDateString, resolveTime, type TimeInput } from "./datetime";

export interface Extracted {
  taken_local: number | null;
  tz_offset: number | null;
  time_source: string | null;
  lat: number | null;
  lon: number | null;
  alt: number | null;
  gps_source: string | null;
  width: number | null;
  height: number | null;
  orientation: number | null;
  duration: number | null;
  make: string | null;
  model: string | null;
  lens: string | null;
  iso: number | null;
  fnumber: number | null;
  exposure: number | null;
  focal: number | null;
  country_code: string | null;
  country: string | null;
  error: string | null;
}

const EXIFR_OPTIONS = {
  tiff: true,
  exif: true,
  gps: true,
  ifd1: false,
  xmp: false,
  icc: false,
  iptc: false,
  jfif: false,
  ihdr: true,
  interop: false,
  makerNote: false,
  userComment: false,
  // Raw strings: exifr would otherwise turn wall-clock dates into Dates in *this* machine's zone.
  reviveValues: false,
  translateValues: false,
  translateKeys: true,
  mergeOutput: true,
  silentErrors: true,
} as const;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const text = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/\0/g, "").trim();
  return t ? t : null;
};

export function validCoords(lat: unknown, lon: unknown): lat is number {
  return (
    typeof lat === "number" &&
    typeof lon === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180 &&
    // "Null Island" is almost always an unset GPS block.
    !(Math.abs(lat) < 1e-6 && Math.abs(lon) < 1e-6)
  );
}

export function countryAt(lat: number, lon: number): { code: string | null; name: string | null } {
  const code = iso1A2Code([lon, lat]);
  if (!code) return { code: null, name: null };
  return { code, name: feature([lon, lat])?.properties.nameEn ?? code };
}

/** Drops vendor suffixes ("NIKON CORPORATION" → "NIKON") so "make model" reads cleanly. */
function cleanMake(make: string | null): string | null {
  if (!make) return null;
  return make.replace(/\s+(corporation|corp\.?|co\.?,?\s*ltd\.?|imaging.*|optical.*|company.*)$/i, "").trim() || null;
}

function altitude(e: Record<string, unknown>): number | null {
  const alt = num(e.GPSAltitude);
  if (alt == null) return null;
  const ref = e.GPSAltitudeRef;
  const below = ref === 1 || (typeof ref === "object" && ref !== null && (ref as Record<string, number>)[0] === 1);
  return below ? -alt : alt;
}

function finish(base: Omit<Extracted, "taken_local" | "tz_offset" | "time_source" | "country_code" | "country">, time: TimeInput): Extracted {
  const t = resolveTime({ ...time, lat: base.lat, lon: base.lon });
  const c = base.lat != null && base.lon != null ? countryAt(base.lat, base.lon) : { code: null, name: null };
  return {
    ...base,
    taken_local: t?.local ?? null,
    tz_offset: t?.offset ?? null,
    time_source: t?.source ?? null,
    country_code: c.code,
    country: c.name,
  };
}

const EMPTY = {
  lat: null, lon: null, alt: null, gps_source: null,
  width: null, height: null, orientation: null, duration: null,
  make: null, model: null, lens: null, iso: null, fnumber: null, exposure: null, focal: null,
  error: null,
} satisfies Partial<Extracted>;

const hasCameraDate = (e: Record<string, unknown> | undefined) =>
  !!e && [e.DateTimeOriginal, e.CreateDate, e.ModifyDate].some((v) => typeof v === "string" && parseDateString(v));

/**
 * Some editors (Windows Photo Gallery, Lightroom, Photoshop) keep the date taken only in
 * XMP. Read as a second pass, only for files without a camera date. Modify dates are
 * ignored here: in XMP they're usually when the file was edited.
 */
async function xmpDates(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const x = await exifr.parse(path, {
      tiff: false, exif: false, gps: false, ifd1: false, interop: false,
      xmp: true, iptc: true, mergeOutput: true, reviveValues: false,
    });
    const DateTimeOriginal = x?.DateTimeOriginal ?? x?.DateCreated;
    const CreateDate = x?.CreateDate;
    return DateTimeOriginal || CreateDate ? { DateTimeOriginal, CreateDate } : undefined;
  } catch {
    return undefined;
  }
}

async function extractImage(path: string, name: string, mtimeMs: number): Promise<Extracted> {
  let e: Record<string, unknown> | undefined;
  let error: string | null = null;
  try {
    e = (await exifr.parse(path, EXIFR_OPTIONS)) ?? undefined;
  } catch (err) {
    error = String((err as Error)?.message ?? err).slice(0, 200);
  }
  const xmp = hasCameraDate(e) ? undefined : await xmpDates(path);
  if (!e) return finish({ ...EMPTY, error }, { name, mtimeMs, exif: xmp });

  const gpsOk = validCoords(e.latitude, e.longitude);
  const w = num(e.ExifImageWidth) ?? num(e.ImageWidth) ?? num(e.PixelXDimension);
  const h = num(e.ExifImageHeight) ?? num(e.ImageHeight) ?? num(e.PixelYDimension);
  const orientation = num(e.Orientation);
  // Store display dimensions: orientations 5–8 are rotated by 90°.
  const swap = orientation != null && orientation >= 5 && orientation <= 8;
  return finish(
    {
      ...EMPTY,
      lat: gpsOk ? (e.latitude as number) : null,
      lon: gpsOk ? (e.longitude as number) : null,
      alt: gpsOk ? altitude(e) : null,
      gps_source: gpsOk ? "exif" : null,
      width: swap ? h : w,
      height: swap ? w : h,
      orientation,
      make: cleanMake(text(e.Make)),
      model: text(e.Model),
      lens: text(e.LensModel),
      iso: num(e.ISO) ?? (Array.isArray(e.ISO) ? num(e.ISO[0]) : null),
      fnumber: num(e.FNumber),
      exposure: num(e.ExposureTime),
      focal: num(e.FocalLength),
      error,
    },
    { name, mtimeMs, exif: xmp ? { ...e, ...xmp } : e },
  );
}

/** "+37.7749-122.4194+010.000/" (ISO 6709, used by Apple and Android). */
export function parseIso6709(s: string | undefined): { lat: number; lon: number; alt: number | null } | null {
  if (!s) return null;
  const m = /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?/.exec(s.trim());
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (!validCoords(lat, lon)) return null;
  return { lat, lon, alt: m[3] ? Number(m[3]) : null };
}

async function extractVideo(path: string, name: string, mtimeMs: number): Promise<Extracted> {
  try {
    const proc = Bun.spawn(["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", path], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const j = JSON.parse(out || "{}") as {
      format?: { duration?: string; tags?: Record<string, string> };
      streams?: { codec_type?: string; width?: number; height?: number; tags?: Record<string, string>; side_data_list?: { rotation?: number }[] }[];
    };
    const tags: Record<string, string> = {};
    for (const [k, v] of Object.entries(j.format?.tags ?? {})) tags[k.toLowerCase()] = v;
    const vs = j.streams?.find((s) => s.codec_type === "video");
    const loc = parseIso6709(tags["com.apple.quicktime.location.iso6709"] ?? tags["location"] ?? tags["location-eng"]);
    const rotation = Math.abs(vs?.side_data_list?.find((d) => d.rotation != null)?.rotation ?? Number(vs?.tags?.rotate ?? 0));
    const rotated = rotation === 90 || rotation === 270;
    return finish(
      {
        ...EMPTY,
        lat: loc?.lat ?? null,
        lon: loc?.lon ?? null,
        alt: loc?.alt ?? null,
        gps_source: loc ? "video" : null,
        width: (rotated ? vs?.height : vs?.width) ?? null,
        height: (rotated ? vs?.width : vs?.height) ?? null,
        duration: num(Number(j.format?.duration)),
        make: cleanMake(text(tags["com.apple.quicktime.make"] ?? tags["make"])),
        model: text(tags["com.apple.quicktime.model"] ?? tags["model"]),
      },
      {
        name,
        mtimeMs,
        video: {
          creationDate: tags["com.apple.quicktime.creationdate"],
          creationTime: tags["creation_time"] ?? vs?.tags?.creation_time,
        },
      },
    );
  } catch (err) {
    return finish({ ...EMPTY, error: String((err as Error)?.message ?? err).slice(0, 200) }, { name, mtimeMs });
  }
}

export function extract(path: string, kind: Kind, name: string, mtimeMs: number): Promise<Extracted> {
  return kind === "video" ? extractVideo(path, name, mtimeMs) : extractImage(path, name, mtimeMs);
}
