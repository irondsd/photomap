import { useEffect, useState } from "react";
import { formatDate, nf } from "./data";

export interface Stats {
  total: number;
  geotagged: number;
  missing: number;
  errors: number;
  range: { min: number | null; max: number | null };
  kinds: { kind: string; n: number }[];
  timeSources: { source: string | null; n: number }[];
  countries: { code: string; name: string; n: number }[];
  cameras: { model: string; n: number }[];
  version: string;
}

export interface ScanStatus {
  running: boolean;
  root: string | null;
  phase: string;
  found: number;
  processed: number;
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
  errors: number;
  queued: number;
  message: string | null;
  version: string;
}

interface Root {
  id: number;
  path: string;
  last_scan_at: number | null;
}

async function api<T>(url: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const r = await fetch(url, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? r.statusText);
  return j as T;
}

export const startScan = (rootId?: number) => api("/api/scan", { method: "POST", body: rootId ? { rootId } : {} });

export function ScanProgress({ scan }: { scan: ScanStatus }) {
  if (!scan.running) return null;
  const pct = scan.found ? Math.round((scan.processed / scan.found) * 100) : 0;
  return (
    <div className="scan-progress">
      <div className="scan-progress-text">
        {scan.phase === "walking" ? `Looking for photos… ${nf.format(scan.found)} found` : `Indexing ${nf.format(scan.processed)} of ${nf.format(scan.found)}`}
        {scan.queued > 0 && <span className="dim"> · {scan.queued} more folder(s) queued</span>}
      </div>
      <div className="progress">
        <div className="progress-fill" style={{ width: scan.phase === "walking" ? "100%" : `${pct}%` }} data-indeterminate={scan.phase === "walking" || undefined} />
      </div>
      <div className="dim small break">{scan.root}</div>
    </div>
  );
}

export function AddFolder({ onAdded, autoFocus }: { onAdded(): void; autoFocus?: boolean }) {
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!path.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/roots", { method: "POST", body: { path } });
      setPath("");
      onAdded();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="add-folder" onSubmit={submit}>
      <div className="row">
        <input
          className="input mono"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="~/Pictures"
          autoFocus={autoFocus}
          spellCheck={false}
          aria-label="Folder path"
        />
        <button className="btn btn-primary" disabled={busy || !path.trim()}>
          Add & scan
        </button>
      </div>
      {error && <div className="error">{error}</div>}
    </form>
  );
}

export function Library({ stats, scan, onClose, onChanged }: { stats: Stats | null; scan: ScanStatus | null; onClose(): void; onChanged(): void }) {
  const [roots, setRoots] = useState<Root[]>([]);
  const reload = () => api<Root[]>("/api/roots").then(setRoots).catch(() => {});
  useEffect(() => {
    reload();
  }, [scan?.running, stats?.version]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const remove = async (r: Root) => {
    if (!confirm(`Remove ${r.path} from the index?\n\nYour files are not touched; only the index entries are removed.`)) return;
    try {
      await api(`/api/roots/${r.id}`, { method: "DELETE" });
    } catch (err) {
      alert((err as Error).message);
    }
    reload();
    onChanged();
  };

  const pct = (n: number) => (stats?.total ? `${Math.round((n / stats.total) * 100)}%` : "");

  return (
    <div className="drawer-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="drawer" role="dialog" aria-label="Library">
        <header className="drawer-head">
          <h2>Library</h2>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <section>
          <h4>Folders</h4>
          <ul className="roots">
            {roots.map((r) => (
              <li key={r.id}>
                <div className="break mono small">{r.path}</div>
                <div className="dim small">{r.last_scan_at ? `Scanned ${new Date(r.last_scan_at).toLocaleString()}` : "Not scanned yet"}</div>
                <div className="row">
                  <button className="btn btn-small" disabled={scan?.running} onClick={() => startScan(r.id).then(onChanged)}>
                    Rescan
                  </button>
                  <button className="btn btn-small btn-danger" onClick={() => remove(r)}>
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <AddFolder onAdded={() => { reload(); onChanged(); }} />
          <p className="dim small">Your photos are only read, never modified. The index and thumbnails live in the app's data folder.</p>
          {scan?.running ? (
            <>
              <ScanProgress scan={scan} />
              <button className="btn btn-small" onClick={() => fetch("/api/scan", { method: "DELETE" })}>
                Cancel scan
              </button>
            </>
          ) : (
            roots.length > 0 && (
              <button className="btn" onClick={() => startScan().then(onChanged)}>
                Rescan all folders
              </button>
            )
          )}
          {scan && !scan.running && scan.phase === "done" && (
            <p className="dim small">
              Last scan: {nf.format(scan.added)} added, {nf.format(scan.updated)} updated, {nf.format(scan.removed)} gone, {nf.format(scan.errors)} unreadable
            </p>
          )}
        </section>

        {stats && stats.total > 0 && (
          <section>
            <h4>Overview</h4>
            <dl className="stats">
              <dt>Photos & videos</dt>
              <dd>{nf.format(stats.total)}</dd>
              <dt>With location</dt>
              <dd>
                {nf.format(stats.geotagged)} <span className="dim">{pct(stats.geotagged)}</span>
              </dd>
              <dt>Date range</dt>
              <dd>{stats.range.min != null && stats.range.max != null ? `${formatDate(stats.range.min)} – ${formatDate(stats.range.max)}` : "—"}</dd>
              {stats.kinds.map((k) => (
                <div key={k.kind} className="stats-row">
                  <dt>{k.kind === "photo" ? "Photos" : k.kind === "raw" ? "RAW" : "Videos"}</dt>
                  <dd>{nf.format(k.n)}</dd>
                </div>
              ))}
            </dl>
            {stats.countries.length > 0 && (
              <>
                <h4>{stats.countries.length} countries</h4>
                <ul className="bars">
                  {stats.countries.slice(0, 15).map((c) => (
                    <li key={c.code}>
                      <span>{c.name}</span>
                      <span className="bar" style={{ width: `${(c.n / stats.countries[0]!.n) * 100}%` }} />
                      <span className="dim">{nf.format(c.n)}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {stats.cameras.length > 0 && (
              <>
                <h4>Cameras</h4>
                <ul className="bars">
                  {stats.cameras.slice(0, 10).map((c) => (
                    <li key={c.model}>
                      <span>{c.model}</span>
                      <span className="bar" style={{ width: `${(c.n / stats.cameras[0]!.n) * 100}%` }} />
                      <span className="dim">{nf.format(c.n)}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
