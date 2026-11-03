// The sync protocol between this app and the Photomap server.
// A copy of the server's src/sync/protocol.ts, which the server's protocol.test.ts keeps identical.

export const PROTOCOL_VERSION = 1;

/** What the QR code in Photomap's Library → Phone sync encodes, as JSON. */
export type PairingPayload = {
  v: typeof PROTOCOL_VERSION;
  /** Base URL the phone can reach on the local network, e.g. http://192.168.1.20:4747 */
  url: string;
  /** Sent as `Authorization: Bearer <token>` on every sync request. */
  token: string;
  /** Shown in the app so you can tell which library you paired with. */
  name: string;
};

/** GET /api/sync/hello */
export type HelloResponse = {
  name: string;
  protocol: number;
};

export type MediaKind = "photo" | "video";

/**
 * One photo or video on the phone. `id` is the phone's own handle for it and only
 * correlates requests; the server recognises files by `filename` + `takenAt`.
 */
export type ManifestItem = {
  id: string;
  filename: string;
  /** Capture time in ms since the epoch, as the phone's media library records it. */
  takenAt: number;
  kind: MediaKind;
};

/** POST /api/sync/check */
export type CheckRequest = { items: ManifestItem[] };
/** The ids of the items the server doesn't have yet. */
export type CheckResponse = { missing: string[] };

/**
 * PUT /api/sync/file, with the file's bytes as the body and these headers.
 * The filename is URI-encoded so any name survives a header.
 */
export const UPLOAD_HEADERS = {
  filename: "X-Photomap-Filename",
  takenAt: "X-Photomap-Taken-At",
  kind: "X-Photomap-Kind",
} as const;

export type UploadResponse = {
  /** Where the server stored it, relative to its sync folder. */
  path: string;
};

/** Most items a single /api/sync/check accepts. */
export const CHECK_BATCH = 500;
