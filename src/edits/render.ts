import sharp from "sharp";
import { frameSize, hasGeometry, hasTweaks, type Edits } from "./model";
import { applyTweaks } from "./tweaks";

export interface RawImage {
  /** RGBA, 8 bits per channel. */
  data: Buffer;
  width: number;
  height: number;
}

const OPEN = { failOn: "none", limitInputPixels: 0, animated: false } as const;
const BLACK = { r: 0, g: 0, b: 0, alpha: 1 };

/**
 * Renders a photo with its edits, as raw RGBA. `maxLong` limits the long side of the result;
 * the photo is scaled down before the geometry so large originals stay cheap for thumbnails.
 * The same steps as the editor's preview: orient, turn and straighten, crop, then tweak.
 */
export async function renderEdits(input: string | Buffer, e: Edits, maxLong: number | null): Promise<RawImage> {
  const meta = await sharp(input, OPEN).metadata();
  const swap = (meta.orientation ?? 1) >= 5;
  const sw = (swap ? meta.height : meta.width) ?? 0;
  const sh = (swap ? meta.width : meta.height) ?? 0;
  if (!sw || !sh) throw new Error("unknown image size");
  const [fw, fh] = frameSize(sw, sh, e.quarter);
  const scale = maxLong ? Math.min(1, maxLong / Math.max(e.crop.w * fw, e.crop.h * fh)) : 1;

  let img = sharp(input, OPEN).rotate();
  if (scale < 1)
    img = img.resize(Math.max(1, Math.round(sw * scale)), Math.max(1, Math.round(sh * scale)), { fit: "fill" });
  let cur = await img.toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  if (hasGeometry(e)) {
    // Frame size at this scale, from the oriented pixels themselves.
    const [w, h] = frameSize(cur.info.width, cur.info.height, e.quarter);
    const deg = e.quarter * 90 + e.angle;
    if (deg !== 0) {
      cur = await sharp(cur.data, { raw: { width: cur.info.width, height: cur.info.height, channels: 4 } })
        .rotate(deg, { background: BLACK })
        .raw()
        .toBuffer({ resolveWithObject: true });
    }
    // An arbitrary rotation grows the canvas to the rotated photo's bounding box, around the same centre.
    const ox = (cur.info.width - w) / 2;
    const oy = (cur.info.height - h) / 2;
    const left = Math.max(0, Math.min(cur.info.width - 1, Math.round(ox + e.crop.x * w)));
    const top = Math.max(0, Math.min(cur.info.height - 1, Math.round(oy + e.crop.y * h)));
    const width = Math.max(1, Math.min(cur.info.width - left, Math.round(e.crop.w * w)));
    const height = Math.max(1, Math.min(cur.info.height - top, Math.round(e.crop.h * h)));
    if (left !== 0 || top !== 0 || width !== cur.info.width || height !== cur.info.height) {
      cur = await sharp(cur.data, { raw: { width: cur.info.width, height: cur.info.height, channels: 4 } })
        .extract({ left, top, width, height })
        .raw()
        .toBuffer({ resolveWithObject: true });
    }
  }

  const out: RawImage = { data: cur.data, width: cur.info.width, height: cur.info.height };
  if (hasTweaks(e.tweaks)) applyTweaks(out.data, out.width, out.height, e.tweaks);
  return out;
}

/** A sharp pipeline over a rendered image. */
export const fromRaw = (r: RawImage) => sharp(r.data, { raw: { width: r.width, height: r.height, channels: 4 } });
