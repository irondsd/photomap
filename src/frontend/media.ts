import { useSyncExternalStore } from "react";

/** Phones and narrow windows: the layout stacks and side panels become sheets. Matches styles.css. */
export const NARROW = "(max-width: 900px)";
/** A finger is the main pointer: no hover, coarse aim. */
export const TOUCH = "(hover: none) and (pointer: coarse)";

/** Whether a media query matches, kept up to date as the window or device changes. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = matchMedia(query);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => matchMedia(query).matches,
  );
}
