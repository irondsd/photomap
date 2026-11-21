import { createContext, useContext, useMemo } from "react";
import { withPhotoVisibility, type PhotoVisibility } from "../photo-visibility";
import { thumbUrl } from "./data";

export const PhotoVisibilityContext = createContext<PhotoVisibility>("public");
export const HidePrivateContext = createContext<(() => void) | null>(null);

export function usePhotoUrls() {
  const visibility = useContext(PhotoVisibilityContext);
  return useMemo(
    () => ({
      visibility,
      photoUrl: (url: string) => withPhotoVisibility(url, visibility),
      thumbnail: (id: number, size: "s" | "m" | "l") => withPhotoVisibility(thumbUrl(id, size), visibility),
    }),
    [visibility],
  );
}
