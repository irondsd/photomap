const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const configuredHosts = new Set(
  (process.env.PHOTOMAP_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean),
);

/** Explicit extra hosts allow local reverse proxies without accepting arbitrary DNS names. */
export function forbidden(req: Request, extraHosts: ReadonlySet<string> = configuredHosts): boolean {
  const host = (req.headers.get("host") ?? "").toLowerCase();
  const hostname = host.replace(/:\d+$/, "");
  if (!LOCAL_HOSTS.has(hostname) && !hostname.endsWith(".localhost") && !extraHosts.has(hostname)) return true;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.get("origin");
    // OrbStack terminates HTTPS before forwarding HTTP to the container.
    if (origin && origin !== `http://${host}` && origin !== `https://${host}`) return true;
  }
  return false;
}
