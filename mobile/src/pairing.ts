import { PROTOCOL_VERSION, type PairingPayload } from "./protocol";

export type Pairing = Omit<PairingPayload, "v">;

/** Reads a scanned QR code; throws with a message worth showing if it isn't a Photomap code. */
export function parsePairing(scanned: string): Pairing {
  let data: unknown;
  try {
    data = JSON.parse(scanned);
  } catch {
    throw new Error("That QR code isn't a Photomap pairing code.");
  }
  if (typeof data !== "object" || data === null) throw new Error("That QR code isn't a Photomap pairing code.");
  const { v, url, token, name } = data as Record<string, unknown>;
  if (v !== PROTOCOL_VERSION) {
    throw new Error("This pairing code is from a different version of Photomap. Update the app or the server.");
  }
  if (typeof url !== "string" || typeof token !== "string" || token === "") {
    throw new Error("That QR code isn't a Photomap pairing code.");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`The pairing code has an invalid address: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`The pairing code has an invalid address: ${url}`);
  }
  return {
    url: url.replace(/\/+$/, ""),
    token,
    name: typeof name === "string" && name !== "" ? name : parsed.host,
  };
}
