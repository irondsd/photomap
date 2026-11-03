import * as SecureStore from "expo-secure-store";
import type { Pairing } from "./pairing";

const PAIRING = "pairing";
const SYNC_FROM = "syncFrom";

/** How far back a sync looks. The server skips what it already has, so a long range only costs a longer check. */
export const SYNC_RANGES = [
  { id: "7d", label: "7 days", days: 7 },
  { id: "30d", label: "30 days", days: 30 },
  { id: "90d", label: "90 days", days: 90 },
  { id: "1y", label: "1 year", days: 365 },
  { id: "all", label: "Everything", days: null },
] as const;

export type SyncRangeId = (typeof SYNC_RANGES)[number]["id"];

export function rangeStart(id: SyncRangeId, now = Date.now()): number {
  const days = SYNC_RANGES.find((r) => r.id === id)?.days ?? null;
  return days === null ? 0 : now - days * 24 * 60 * 60 * 1000;
}

export async function loadPairing(): Promise<Pairing | null> {
  const raw = await SecureStore.getItemAsync(PAIRING);
  return raw ? (JSON.parse(raw) as Pairing) : null;
}

export async function savePairing(pairing: Pairing | null): Promise<void> {
  if (pairing) await SecureStore.setItemAsync(PAIRING, JSON.stringify(pairing));
  else await SecureStore.deleteItemAsync(PAIRING);
}

export async function loadSyncRange(): Promise<SyncRangeId> {
  const raw = await SecureStore.getItemAsync(SYNC_FROM);
  return SYNC_RANGES.some((r) => r.id === raw) ? (raw as SyncRangeId) : "30d";
}

export async function saveSyncRange(id: SyncRangeId): Promise<void> {
  await SecureStore.setItemAsync(SYNC_FROM, id);
}
