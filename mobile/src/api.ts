import type { Pairing } from "./pairing";
import {
  PROTOCOL_VERSION,
  type CheckRequest,
  type CheckResponse,
  type HelloResponse,
  type ManifestItem,
} from "./protocol";

/** A request the server answered with an error, as opposed to one that never got through. */
export class ServerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(pairing: Pairing, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(pairing.url + path, {
    ...init,
    headers: { Authorization: `Bearer ${pairing.token}`, "Content-Type": "application/json", ...init.headers },
  });
  if (!res.ok) throw new ServerError(res.status, errorMessage(res.status, await res.text()));
  return (await res.json()) as T;
}

/** The message to show for a failed request: the server's own `{ error }` when it sent one. */
export function errorMessage(status: number, body: string): string {
  if (status === 401) return "Photomap no longer accepts this phone. Scan the code in Library → Phone sync again.";
  try {
    const { error } = JSON.parse(body) as { error?: unknown };
    if (typeof error === "string") return error;
  } catch {
    // Not JSON, e.g. a proxy's error page.
  }
  return `Photomap answered ${status}.`;
}

export async function hello(pairing: Pairing, signal?: AbortSignal): Promise<HelloResponse> {
  const res = await request<HelloResponse>(pairing, "/api/sync/hello", { signal });
  if (res.protocol !== PROTOCOL_VERSION) {
    throw new Error("Photomap and this app speak different sync versions. Update the older one.");
  }
  return res;
}

export async function check(pairing: Pairing, items: ManifestItem[]): Promise<string[]> {
  const body: CheckRequest = { items };
  const res = await request<CheckResponse>(pairing, "/api/sync/check", { method: "POST", body: JSON.stringify(body) });
  return res.missing;
}
