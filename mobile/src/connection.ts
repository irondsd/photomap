import { ServerError, hello } from "./api";
import type { Pairing } from "./pairing";

export type Connection =
  | { state: "checking" }
  | { state: "online"; name: string }
  /** The Mac didn't answer (asleep, off this wifi, or a new address), or answered with an error. */
  | { state: "offline"; reason: string }
  /** The Mac answered but no longer accepts this phone's token. */
  | { state: "unpaired" };

/** Long enough for a Mac waking from idle, short enough that opening the app doesn't feel stuck. */
export const PROBE_TIMEOUT_MS = 3000;

/** Asks the paired Mac whether it's there. Never throws. */
export async function probe(pairing: Pairing, timeoutMs = PROBE_TIMEOUT_MS): Promise<Connection> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await hello(pairing, controller.signal);
    return { state: "online", name: res.name || pairing.name };
  } catch (e) {
    if (e instanceof ServerError && e.status === 401) return { state: "unpaired" };
    if (e instanceof ServerError) return { state: "offline", reason: e.message };
    // Aborted by the timeout, or the request never got through.
    if (controller.signal.aborted || e instanceof TypeError) {
      return { state: "offline", reason: `Can't reach ${pairing.name} at ${host(pairing.url)}.` };
    }
    return { state: "offline", reason: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

export function host(url: string): string {
  return url.replace(/^https?:\/\//, "");
}
