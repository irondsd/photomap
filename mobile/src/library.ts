import { AssetField, MediaType, Query, requestPermissionsAsync } from "expo-media-library";
import type { ManifestItem } from "./protocol";

export type LibraryAccess = "all" | "limited" | "denied";

/** Asks for photos and videos (and, through the config plugin, their locations). */
export async function requestLibraryAccess(): Promise<LibraryAccess> {
  const res = await requestPermissionsAsync(false, ["photo", "video"]);
  if (!res.granted) return "denied";
  return res.accessPrivileges === "limited" ? "limited" : "all";
}

export type LibraryPage = {
  items: ManifestItem[];
  /** Assets the query returned, including ones skipped for missing a name or a capture time. */
  count: number;
};

/** Photos and videos taken at or after `since` (ms), oldest first. */
export async function listSince(since: number, offset: number, limit: number): Promise<LibraryPage> {
  const assets = await new Query()
    .within(AssetField.MEDIA_TYPE, [MediaType.IMAGE, MediaType.VIDEO])
    .gte(AssetField.CREATION_TIME, since)
    .orderBy({ key: AssetField.CREATION_TIME, ascending: true })
    .offset(offset)
    .limit(limit)
    .exeForMetadata();
  const items: ManifestItem[] = [];
  for (const asset of assets) {
    if (!asset.filename || asset.creationTime == null) continue;
    items.push({
      id: asset.id,
      filename: asset.filename,
      takenAt: asset.creationTime,
      kind: asset.mediaType === MediaType.VIDEO ? "video" : "photo",
    });
  }
  return { items, count: assets.length };
}
