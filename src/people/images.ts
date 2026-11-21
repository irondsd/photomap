import sharp from "sharp";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { systemDecode, type ThumbSource } from "../thumbs";

const ANALYSIS_SIZE = 960;

export async function faceImage(photo: ThumbSource): Promise<Buffer | null> {
  const resize = (input: string | Buffer) =>
    sharp(input, { failOn: "none" })
      .autoOrient()
      .resize(ANALYSIS_SIZE, ANALYSIS_SIZE, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 86 })
      .toBuffer()
      .catch(() => null);

  const direct = await resize(photo.path);
  if (direct) return direct;
  const input = await systemDecode(photo, ANALYSIS_SIZE, join(tmpdir(), `photomap-face-${crypto.randomUUID()}`));
  return input ? resize(input) : null;
}

export interface FaceBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export async function faceCover(photo: ThumbSource, box: FaceBox): Promise<Buffer | null> {
  const bytes = await faceImage(photo);
  if (!bytes) return null;
  const image = sharp(bytes);
  const { width, height } = await image.metadata();
  const size = Math.max(1, Math.round(Math.min(width, height, 1.5 * Math.max(box.w * width, box.h * height))));
  const left = Math.max(0, Math.min(width - size, Math.round((box.x + box.w / 2) * width - size / 2)));
  const top = Math.max(0, Math.min(height - size, Math.round((box.y + box.h / 2) * height - size / 2)));
  return image.extract({ left, top, width: size, height: size }).resize(192, 192).jpeg({ quality: 82 }).toBuffer();
}
