import { File } from "expo-file-system";
import { Asset } from "expo-media-library";
import { ServerError, errorMessage } from "./api";
import type { Pairing } from "./pairing";
import { UPLOAD_HEADERS, type ManifestItem } from "./protocol";

/** Streams the original file from disk to the server, so large videos never pass through JS. */
export async function uploadItem(
  pairing: Pairing,
  item: ManifestItem,
  onBytes: (sent: number, total: number) => void,
  signal: AbortSignal,
): Promise<void> {
  const uri = await new Asset(item.id).getUri();
  const res = await new File(uri).upload(`${pairing.url}/api/sync/file`, {
    httpMethod: "PUT",
    headers: {
      Authorization: `Bearer ${pairing.token}`,
      "Content-Type": "application/octet-stream",
      [UPLOAD_HEADERS.filename]: encodeURIComponent(item.filename),
      [UPLOAD_HEADERS.takenAt]: String(item.takenAt),
      [UPLOAD_HEADERS.kind]: item.kind,
    },
    onProgress: ({ bytesSent, totalBytes }) => onBytes(bytesSent, totalBytes),
    signal,
  });
  if (res.status < 200 || res.status >= 300) throw new ServerError(res.status, errorMessage(res.status, res.body));
}
