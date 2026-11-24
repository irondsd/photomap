// Messages between this app and the Photomap web app it shows in a WebView.
// The web app keeps a copy of these types in src/frontend/phoneApp.ts; keep the two in step.

import type { SyncProgress, SyncResult } from "./sync";

export const BRIDGE_VERSION = 1;

/** Something worth telling the user that isn't part of a sync's result, e.g. missing photo access. */
export type SyncNotice = {
  text: string;
  /** Tapping it should open the app's system settings. */
  settings?: boolean;
};

/** Everything the web app shows about phone sync. Sent whole on every change. */
export type AppSyncState = {
  /** The paired computer's name and address, e.g. "MacBook" · "192.168.1.20:4747". */
  server: string;
  host: string;
  ranges: { id: string; label: string }[];
  range: string;
  running: boolean;
  /** Whether the current or last run started by itself, on opening the app. */
  auto: boolean;
  /** Counts up with each run, so the page can tell a new result from one it already showed. */
  run: number;
  progress: SyncProgress | null;
  result: SyncResult | null;
  notice: SyncNotice | null;
  finishedAt: number | null;
};

/** From the web app to this one. */
export type WebMessage =
  | { type: "ready" }
  | { type: "sync" }
  | { type: "stop" }
  | { type: "range"; id: string }
  | { type: "settings" }
  | { type: "rescan" }
  | { type: "unpair" }
  /** The page's resolved theme, so the bars around it can match. */
  | { type: "theme"; dark: boolean };

/** The global the page reads to know it's inside the app, set before any of its scripts run. */
export const injectedBeforeLoad = `window.photomapApp = { version: ${BRIDGE_VERSION} }; true;`;

/** A script that hands the page the latest state. */
export function stateScript(state: AppSyncState): string {
  // JSON is valid JS, apart from two line separators that JSON allows inside strings.
  const json = JSON.stringify(state).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
  return `window.photomapApp && (window.photomapApp.state = ${json}, window.dispatchEvent(new Event("photomap-app-state"))); true;`;
}

export function parseWebMessage(data: string): WebMessage | null {
  try {
    const msg = JSON.parse(data) as { type?: unknown };
    return typeof msg?.type === "string" ? (msg as WebMessage) : null;
  } catch {
    return null;
  }
}
