export type PhotoVisibility = "public" | "private" | "all";

export function withPhotoVisibility(url: string, visibility: PhotoVisibility): string {
  if (visibility === "public") return url;
  return `${url}${url.includes("?") ? "&" : "?"}visibility=${visibility}`;
}
