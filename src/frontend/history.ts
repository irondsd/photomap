import { useEffect, useRef } from "react";

/**
 * Overlays (the viewer, the editor, the library) aren't pages, so the browser's Back would leave the app.
 * Each open overlay holds a history entry of its own instead, and Back closes the innermost one.
 */
interface Entry {
  /** Closes the overlay; false when it stays open (e.g. the user kept unsaved changes). */
  onBack(): boolean | void;
  /** Its history entry was already used up by Back. */
  popped: boolean;
}

const STATE = { overlay: true };
const open: Entry[] = [];
/** Pops we caused ourselves, for overlays closed some other way: not a Back for the next one down. */
let ownPops = 0;
let pendingBack = 0;

window.addEventListener("popstate", () => {
  if (ownPops > 0) {
    ownPops--;
    return;
  }
  const top = open.at(-1);
  if (!top) return;
  top.popped = true;
  if (top.onBack() === false) {
    history.pushState(STATE, "");
    top.popped = false;
  }
});

/** Overlays closing together (the viewer with its editor) go back in one step. */
function goBack() {
  if (pendingBack++ > 0) return;
  queueMicrotask(() => {
    ownPops++;
    history.go(-pendingBack);
    pendingBack = 0;
  });
}

/** While mounted, the browser's Back calls `onBack` rather than leaving the page. */
export function useBackToClose(onBack: () => boolean | void) {
  const ref = useRef(onBack);
  ref.current = onBack;
  useEffect(() => {
    const entry: Entry = { onBack: () => ref.current(), popped: false };
    history.pushState(STATE, "");
    open.push(entry);
    return () => {
      open.splice(open.indexOf(entry), 1);
      if (!entry.popped) goBack();
    };
  }, []);
}
