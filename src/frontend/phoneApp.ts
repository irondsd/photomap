import { useEffect, useSyncExternalStore } from "react";

// The Photomap phone app shows this web app in a WebView and runs phone sync itself, since only it can
// read the phone's photos. It tells the page it's there (`window.photomapApp`), sends the sync state on
// every change, and takes commands back. A copy of the app's mobile/src/bridge.ts; keep the two in step.

export type SyncProgress =
  | { phase: "checking"; scanned: number; missing: number }
  | {
      phase: "uploading";
      done: number;
      total: number;
      failed: number;
      current: string;
      bytesSent: number;
      bytesTotal: number;
    };

export type SyncResult = {
  scanned: number;
  present: number;
  uploaded: number;
  failed: { filename: string; error: string }[];
  stopped?: string;
  cancelled: boolean;
};

export type SyncNotice = { text: string; settings?: boolean };

export type AppSyncState = {
  server: string;
  host: string;
  ranges: { id: string; label: string }[];
  range: string;
  running: boolean;
  auto: boolean;
  run: number;
  progress: SyncProgress | null;
  result: SyncResult | null;
  notice: SyncNotice | null;
  finishedAt: number | null;
};

export type AppCommand =
  | { type: "ready" }
  | { type: "sync" }
  | { type: "stop" }
  | { type: "range"; id: string }
  | { type: "settings" }
  | { type: "rescan" }
  | { type: "unpair" }
  | { type: "theme"; dark: boolean };

declare global {
  interface Window {
    photomapApp?: { version: number; state?: AppSyncState };
    ReactNativeWebView?: { postMessage(message: string): void };
  }
}

/** Whether this page is running inside the phone app. Fixed for the page's life. */
export const inPhoneApp = typeof window !== "undefined" && !!window.photomapApp && !!window.ReactNativeWebView;

export function sendToApp(command: AppCommand) {
  window.ReactNativeWebView?.postMessage(JSON.stringify(command));
}

const EVENT = "photomap-app-state";

function subscribe(onChange: () => void) {
  window.addEventListener(EVENT, onChange);
  return () => window.removeEventListener(EVENT, onChange);
}

const snapshot = () => window.photomapApp?.state ?? null;

/** The phone app's sync state, or null outside the app (and until the app first sends it). */
export function usePhoneSync(): AppSyncState | null {
  return useSyncExternalStore(inPhoneApp ? subscribe : noop, inPhoneApp ? snapshot : nothing);
}

const noop = () => () => {};
const nothing = () => null;

/** Asks the app for its state, and keeps it told of the page's light/dark theme for the bars around it. */
export function useAppBridge() {
  useEffect(() => {
    if (!inPhoneApp) return;
    sendToApp({ type: "ready" });
    const root = document.documentElement;
    let last: boolean | null = null;
    const report = () => {
      const dark = root.dataset.theme === "dark";
      if (dark !== last) sendToApp({ type: "theme", dark });
      last = dark;
    };
    report();
    const observer = new MutationObserver(report);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
}

export function plural(n: number, word: string) {
  return `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** How far through a sync is, from 0 to 1; null while it's still checking. */
export function syncFraction(p: SyncProgress): number | null {
  if (p.phase === "checking") return null;
  const fileShare = p.bytesTotal > 0 ? p.bytesSent / p.bytesTotal : 0;
  return p.total > 0 ? Math.min(1, (p.done + fileShare) / p.total) : 1;
}

/** One line on where a sync is or how it ended, for the toast and the Phone sync tab. */
export function syncHeadline(s: AppSyncState): string {
  const p = s.progress;
  if (s.running && p) {
    if (p.phase === "checking") return p.scanned === 0 ? "Syncing…" : `Checking ${plural(p.scanned, "photo")}…`;
    return `Sending ${Math.min(p.done + 1, p.total).toLocaleString()} of ${p.total.toLocaleString()}`;
  }
  if (s.running) return "Syncing…";
  const r = s.result;
  if (!r) return s.notice ? "Sync didn't start" : "Not synced yet";
  if (r.cancelled) return "Sync stopped";
  if (r.stopped) return "Sync didn't finish";
  if (r.failed.length > 0) return `${plural(r.failed.length, "file")} didn't sync`;
  if (r.uploaded === 0) return "Up to date";
  return `${plural(r.uploaded, "file")} synced`;
}

/** Whether the last run ended in something the user should look at. */
export function syncNeedsAttention(s: AppSyncState): boolean {
  if (s.running) return false;
  const r = s.result;
  return (!r && !!s.notice?.settings) || (!!r && !r.cancelled && (!!r.stopped || r.failed.length > 0));
}
